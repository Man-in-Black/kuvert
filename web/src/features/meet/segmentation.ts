/**
 * Ruhigere Personen-Maske für Hintergrund-Effekte.
 *
 * LiveKits BackgroundTransformer nimmt von MediaPipe nur die harte Kategorie-Maske (Person ja/nein
 * bei 50 %). Jeder Frame wird für sich entschieden, deshalb springen Kanten, Haare und Dinge, bei
 * denen das Modell unsicher ist (Stuhllehne, Jacke dahinter), von Frame zu Frame hin und her.
 *
 * Diese Variante holt stattdessen die Wahrscheinlichkeits-Maske und schiebt einen eigenen
 * WebGL-Schritt dazwischen, bevor LiveKit die Maske weichzeichnet und zusammensetzt:
 *  - leicht räumlich geglättet (einzelne Ausreißer-Pixel verschwinden),
 *  - Schwelle etwas über 50 % mit weichem Übergang (weniger heller Saum am Kopf,
 *    weniger halb erkannte Gegenstände),
 *  - zeitlich geglättet: kleine Änderungen werden stark gedämpft (kein Flackern), große
 *    Änderungen – echte Bewegung – kommen sofort durch (kein Nachziehen).
 *
 * Läuft im selben WebGL-Kontext wie MediaPipe und LiveKit; die Maske verlässt die GPU nicht.
 */
import type { ImageSegmenterResult } from '@mediapipe/tasks-vision';
import {
  BackgroundProcessorWrapper,
  BackgroundTransformer,
  supportsBackgroundProcessors,
  type BackgroundOptions,
} from '@livekit/track-processors';

export { BackgroundProcessorWrapper, supportsBackgroundProcessors };

/** Ab welcher Modell-Sicherheit ein Pixel als Person gilt (weicher Übergang dazwischen) */
const PERSON_FROM = 0.5;
const PERSON_FULL = 0.8;
/** Anteil des neuen Frames: ruhige Bereiche / bei deutlicher Änderung */
const FOLLOW_SLOW = 0.3;
const FOLLOW_FAST = 0.9;
/** Längste Kante des internen Masken-Puffers in Pixeln */
const STATE_EDGE = 480;

const VERTEX = `#version 300 es
in vec2 position;
out vec2 texCoords;
void main() {
  // Bewusst ohne Y-Spiegelung: dieser Schritt soll die Maske 1:1 abbilden
  texCoords = (position + 1.0) / 2.0;
  gl_Position = vec4(position, 0.0, 1.0);
}`;

// Ausgabe wie LiveKits Kategorie-Maske: 1 = Hintergrund, 0 = Person (im Rotkanal)
const FRAGMENT = `#version 300 es
precision highp float;
in vec2 texCoords;
uniform sampler2D u_confidence;
uniform sampler2D u_previous;
uniform vec2 u_texel;
uniform vec2 u_range;
uniform vec2 u_follow;
uniform bool u_reset;
out vec4 fragColor;

float conf(vec2 offset) {
  return texture(u_confidence, texCoords + offset * u_texel).r;
}

void main() {
  // 3×3-Zeltfilter auf der Wahrscheinlichkeit
  float c = conf(vec2(0.0)) * 4.0
    + (conf(vec2(1.0, 0.0)) + conf(vec2(-1.0, 0.0)) + conf(vec2(0.0, 1.0)) + conf(vec2(0.0, -1.0))) * 2.0
    + conf(vec2(1.0, 1.0)) + conf(vec2(-1.0, 1.0)) + conf(vec2(1.0, -1.0)) + conf(vec2(-1.0, -1.0));
  c /= 16.0;

  float background = 1.0 - smoothstep(u_range.x, u_range.y, c);
  if (u_reset) {
    fragColor = vec4(background, background, background, 1.0);
    return;
  }
  float previous = texture(u_previous, texCoords).r;
  float follow = mix(u_follow.x, u_follow.y, smoothstep(0.15, 0.5, abs(background - previous)));
  float value = mix(previous, background, follow);
  fragColor = vec4(value, value, value, 1.0);
}`;

/** Eigener GL-Schritt: Wahrscheinlichkeit → geglättete Hintergrund-Maske (Ping-Pong-Puffer) */
class MaskSmoother {
  private program: WebGLProgram;
  private buffer: WebGLBuffer;
  private textures: WebGLTexture[] = [];
  private framebuffers: WebGLFramebuffer[] = [];
  private uniforms: Record<'confidence' | 'previous' | 'texel' | 'range' | 'follow' | 'reset', WebGLUniformLocation | null>;
  private width = 0;
  private height = 0;
  private current = 0;
  private fresh = true;

  constructor(private gl: WebGL2RenderingContext) {
    const vs = this.shader(gl.VERTEX_SHADER, VERTEX);
    const fs = this.shader(gl.FRAGMENT_SHADER, FRAGMENT);
    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.bindAttribLocation(program, 0, 'position');
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`Masken-Shader lässt sich nicht linken: ${log}`);
    }
    this.program = program;
    this.uniforms = {
      confidence: gl.getUniformLocation(program, 'u_confidence'),
      previous: gl.getUniformLocation(program, 'u_previous'),
      texel: gl.getUniformLocation(program, 'u_texel'),
      range: gl.getUniformLocation(program, 'u_range'),
      follow: gl.getUniformLocation(program, 'u_follow'),
      reset: gl.getUniformLocation(program, 'u_reset'),
    };
    this.buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, -1, -1, 1, 1, 1, -1]), gl.STATIC_DRAW);
    for (let i = 0; i < 2; i++) {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const fb = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      this.textures.push(tex);
      this.framebuffers.push(fb);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private shader(type: number, source: string) {
    const gl = this.gl;
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`Masken-Shader lässt sich nicht übersetzen: ${log}`);
    }
    return shader;
  }

  private resize(frameWidth: number, frameHeight: number) {
    const scale = Math.min(1, STATE_EDGE / Math.max(frameWidth, frameHeight));
    const w = Math.max(1, Math.round(frameWidth * scale));
    const h = Math.max(1, Math.round(frameHeight * scale));
    if (w === this.width && h === this.height) return;
    const gl = this.gl;
    for (const tex of this.textures) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    this.width = w;
    this.height = h;
    this.fresh = true;
  }

  /** Neue Wahrscheinlichkeits-Maske einarbeiten; liefert die geglättete Hintergrund-Maske */
  process(confidence: WebGLTexture, frameWidth: number, frameHeight: number): WebGLTexture {
    const gl = this.gl;
    this.resize(frameWidth, frameHeight);
    const previous = this.current;
    const next = 1 - previous;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffers[next]!);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.BLEND);
    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, confidence);
    gl.uniform1i(this.uniforms.confidence, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.textures[previous]!);
    gl.uniform1i(this.uniforms.previous, 1);
    gl.uniform2f(this.uniforms.texel, 1 / this.width, 1 / this.height);
    gl.uniform2f(this.uniforms.range, PERSON_FROM, PERSON_FULL);
    gl.uniform2f(this.uniforms.follow, FOLLOW_SLOW, FOLLOW_FAST);
    gl.uniform1i(this.uniforms.reset, this.fresh ? 1 : 0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.current = next;
    this.fresh = false;
    return this.textures[next]!;
  }

  dispose() {
    const gl = this.gl;
    for (const fb of this.framebuffers) gl.deleteFramebuffer(fb);
    for (const tex of this.textures) gl.deleteTexture(tex);
    gl.deleteBuffer(this.buffer);
    gl.deleteProgram(this.program);
    this.framebuffers = [];
    this.textures = [];
  }
}

/**
 * BackgroundTransformer mit Wahrscheinlichkeits-Maske und Glättung. Zusammensetzen (Weichzeichnen,
 * Hintergrundbild, Kantenverlauf) übernimmt weiterhin LiveKits WebGL-Pipeline.
 */
export class SmoothBackgroundTransformer extends BackgroundTransformer {
  private smoother?: MaskSmoother;

  override async init(...args: Parameters<BackgroundTransformer['init']>) {
    this.disposeSmoother();
    await super.init(...args);
    await this.imageSegmenter?.setOptions({ outputCategoryMask: false, outputConfidenceMasks: true });
  }

  override async restart(...args: Parameters<BackgroundTransformer['restart']>) {
    // Neuer Canvas = neuer WebGL-Kontext; der alte Puffer gehört zum alten Kontext
    this.disposeSmoother();
    await super.restart(...args);
  }

  override async destroy(...args: Parameters<BackgroundTransformer['destroy']>) {
    this.disposeSmoother();
    await super.destroy(...args);
  }

  private disposeSmoother() {
    try {
      this.smoother?.dispose();
    } catch {
      /* Kontext schon weg */
    }
    this.smoother = undefined;
  }

  private smoothMask(result: ImageSegmenterResult, width: number, height: number) {
    const mask = result.confidenceMasks?.[0];
    if (!mask || !this.gl || !this.canvas) return;
    // Liefert den bestehenden Kontext, den sich MediaPipe und LiveKit teilen
    const gl = (this.canvas as OffscreenCanvas).getContext('webgl2');
    if (!gl) return;
    this.smoother ??= new MaskSmoother(gl);
    this.gl.updateMask(this.smoother.process(mask.getAsWebGLTexture(), width, height));
  }

  /** Wie im Original, nur mit smoothMask statt der Kategorie-Maske */
  override async transform(frame: VideoFrame, controller: TransformStreamDefaultController<VideoFrame>) {
    let enqueued = false;
    try {
      if (!(frame instanceof VideoFrame) || frame.codedWidth === 0 || frame.codedHeight === 0) return;

      const skip =
        this.isDisabled ||
        (this.options.backgroundDisabled ?? false) ||
        (typeof this.options.blurRadius !== 'number' && typeof this.options.imagePath !== 'string');
      if (skip) {
        controller.enqueue(frame);
        enqueued = true;
        return;
      }

      const frameTimeMs = Date.now();
      if (!this.canvas) throw new TypeError('Canvas needs to be initialized first');
      this.canvas.width = frame.displayWidth;
      this.canvas.height = frame.displayHeight;

      // Ersten Frame sofort unverändert zeigen, während Segmentierung und Zeichnen anlaufen
      if (this.isFirstFrame) {
        controller.enqueue(frame.clone());
        const video = this.inputVideo;
        if (video) {
          await new Promise((resolve) => {
            video.requestVideoFrameCallback((_now, e) => {
              setTimeout(resolve, e.expectedDisplayTime - e.presentationTime);
            });
          });
        }
      }
      if (this.isDisabled || !this.imageSegmenter) return;
      this.isFirstFrame = false;

      const filterStart = performance.now();
      // segmentForVideo läuft synchron, der Rückruf kommt noch vor dem Zeichnen
      const segmentStart = performance.now();
      this.imageSegmenter.segmentForVideo(frame, segmentStart, (result) => {
        this.segmentationTimeMs = performance.now() - segmentStart;
        try {
          this.smoothMask(result, frame.displayWidth, frame.displayHeight);
        } finally {
          result.close();
        }
      });

      this.gl?.renderFrame(frame);
      if (this.canvas.width > 0 && this.canvas.height > 0) {
        controller.enqueue(new VideoFrame(this.canvas, { timestamp: frame.timestamp || frameTimeMs }));
        const filterTimeMs = performance.now() - filterStart;
        this.options.onFrameProcessed?.({
          processingTimeMs: this.segmentationTimeMs + filterTimeMs,
          segmentationTimeMs: this.segmentationTimeMs,
          filterTimeMs,
        });
      } else {
        controller.enqueue(frame);
        enqueued = true;
      }
    } catch (e) {
      console.error('Hintergrund-Effekt: Frame konnte nicht verarbeitet werden', e);
    } finally {
      if (!enqueued) frame.close();
    }
  }
}

/** Wie LiveKits BackgroundProcessor(), aber mit der geglätteten Maske */
export function SmoothBackgroundProcessor(opts: BackgroundOptions) {
  return new BackgroundProcessorWrapper(new SmoothBackgroundTransformer(opts), 'background-processor');
}
