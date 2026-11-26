/**
 * Emoji-Kurzcodes (:smile:, :+1: …) wie Mattermost sie in Texten und Reaktionen verwendet.
 * Je Zeile: Emoji, Hauptname (für Reaktionen an Mattermost), weitere Namen.
 * Unbekannte Namen (z. B. eigene Emojis eines Servers) bleiben als :name: stehen.
 */
const TABLE: string[][] = [
  /* Gesichter */
  ['😀', 'grinning'], ['😃', 'smiley'], ['😄', 'smile'], ['😁', 'grin'], ['😆', 'laughing', 'satisfied'], ['😅', 'sweat_smile'],
  ['🤣', 'rolling_on_the_floor_laughing', 'rofl'], ['😂', 'joy'], ['🙂', 'slightly_smiling_face'], ['🙃', 'upside_down_face'],
  ['🫠', 'melting_face'], ['😉', 'wink'], ['😊', 'blush'], ['😇', 'innocent'],
  ['🥰', 'smiling_face_with_3_hearts', 'smiling_face_with_three_hearts'], ['😍', 'heart_eyes'],
  ['🤩', 'star-struck', 'grinning_face_with_star_eyes', 'star_struck'], ['😘', 'kissing_heart'], ['😗', 'kissing'], ['☺️', 'relaxed'],
  ['😚', 'kissing_closed_eyes'], ['😙', 'kissing_smiling_eyes'], ['🥲', 'smiling_face_with_tear'], ['😋', 'yum'],
  ['😛', 'stuck_out_tongue'], ['😜', 'stuck_out_tongue_winking_eye'], ['🤪', 'zany_face', 'grinning_face_with_one_large_and_one_small_eye'],
  ['😝', 'stuck_out_tongue_closed_eyes'], ['🤑', 'money_mouth_face'], ['🤗', 'hugging_face', 'hugs', 'hugging'],
  ['🤭', 'face_with_hand_over_mouth', 'hand_over_mouth'], ['🤫', 'shushing_face'], ['🤔', 'thinking_face', 'thinking'],
  ['🤐', 'zipper_mouth_face'], ['🤨', 'face_with_raised_eyebrow', 'raised_eyebrow'], ['😐', 'neutral_face'], ['😑', 'expressionless'],
  ['😶', 'no_mouth'], ['😏', 'smirk'], ['😒', 'unamused'], ['🙄', 'face_with_rolling_eyes', 'roll_eyes'], ['😬', 'grimacing'],
  ['🤥', 'lying_face'], ['😌', 'relieved'], ['😔', 'pensive'], ['😪', 'sleepy'], ['🤤', 'drooling_face'], ['😴', 'sleeping'],
  ['😷', 'mask'], ['🤒', 'face_with_thermometer'], ['🤕', 'face_with_head_bandage'], ['🤢', 'nauseated_face'],
  ['🤮', 'face_vomiting', 'vomiting_face'], ['🤧', 'sneezing_face'], ['🥵', 'hot_face'], ['🥶', 'cold_face'], ['🥴', 'woozy_face'],
  ['😵', 'dizzy_face'], ['🤯', 'exploding_head', 'shocked_face_with_exploding_head'], ['🤠', 'face_with_cowboy_hat', 'cowboy_hat_face'],
  ['🥳', 'partying_face'], ['😎', 'sunglasses'], ['🤓', 'nerd_face'], ['🧐', 'face_with_monocle', 'monocle_face'], ['😕', 'confused'],
  ['😟', 'worried'], ['🙁', 'slightly_frowning_face'], ['☹️', 'white_frowning_face', 'frowning_face'], ['😮', 'open_mouth'],
  ['😯', 'hushed'], ['😲', 'astonished'], ['😳', 'flushed'], ['🥺', 'pleading_face'], ['😦', 'frowning'], ['😧', 'anguished'],
  ['😨', 'fearful'], ['😰', 'cold_sweat'], ['😥', 'disappointed_relieved'], ['😢', 'cry'], ['😭', 'sob'], ['😱', 'scream'],
  ['😖', 'confounded'], ['😣', 'persevere'], ['😞', 'disappointed'], ['😓', 'sweat'], ['😩', 'weary'], ['😫', 'tired_face'],
  ['🥱', 'yawning_face'], ['😤', 'triumph'], ['😡', 'rage', 'pout'], ['😠', 'angry'],
  ['🤬', 'face_with_symbols_on_mouth', 'cursing_face', 'serious_face_with_symbols_covering_mouth'], ['😈', 'smiling_imp'], ['👿', 'imp'],
  ['💀', 'skull'], ['💩', 'hankey', 'poop', 'shit'], ['🤡', 'clown_face'], ['👹', 'japanese_ogre'], ['👻', 'ghost'], ['👽', 'alien'],
  ['🤖', 'robot_face', 'robot'], ['😺', 'smiley_cat'], ['😸', 'smile_cat'], ['😹', 'joy_cat'], ['😻', 'heart_eyes_cat'],
  ['🙈', 'see_no_evil'], ['🙉', 'hear_no_evil'], ['🙊', 'speak_no_evil'], ['🫡', 'saluting_face'],
  /* Herzen & Zeichen */
  ['❤️', 'heart'], ['🧡', 'orange_heart'], ['💛', 'yellow_heart'], ['💚', 'green_heart'], ['💙', 'blue_heart'], ['💜', 'purple_heart'],
  ['🖤', 'black_heart'], ['🤍', 'white_heart'], ['🤎', 'brown_heart'], ['💔', 'broken_heart'],
  ['❣️', 'heavy_heart_exclamation_mark_ornament', 'heavy_heart_exclamation'], ['💕', 'two_hearts'], ['💞', 'revolving_hearts'],
  ['💓', 'heartbeat'], ['💗', 'heartpulse'], ['💖', 'sparkling_heart'], ['💘', 'cupid'], ['💝', 'gift_heart'], ['💋', 'kiss'],
  ['💯', '100'], ['💢', 'anger'], ['💥', 'boom', 'collision'], ['💫', 'dizzy'], ['💦', 'sweat_drops'], ['💨', 'dash'],
  ['💬', 'speech_balloon'], ['💭', 'thought_balloon'], ['💤', 'zzz'],
  /* Hände & Körper */
  ['👋', 'wave'], ['🤚', 'raised_back_of_hand'], ['🖐️', 'raised_hand_with_fingers_splayed'], ['✋', 'hand', 'raised_hand'],
  ['🖖', 'spock-hand', 'vulcan_salute'], ['👌', 'ok_hand'], ['🤌', 'pinched_fingers'], ['🤏', 'pinching_hand'], ['✌️', 'v'],
  ['🤞', 'crossed_fingers', 'hand_with_index_and_middle_fingers_crossed'], ['🤟', 'i_love_you_hand_sign', 'love_you_gesture'],
  ['🤘', 'the_horns', 'sign_of_the_horns', 'metal'], ['🤙', 'call_me_hand'], ['👈', 'point_left'], ['👉', 'point_right'],
  ['👆', 'point_up_2'], ['🖕', 'middle_finger', 'reversed_hand_with_middle_finger_extended', 'fu'], ['👇', 'point_down'],
  ['☝️', 'point_up'], ['👍', '+1', 'thumbsup'], ['👎', '-1', 'thumbsdown'], ['✊', 'fist', 'fist_raised'],
  ['👊', 'facepunch', 'punch', 'fist_oncoming'], ['🤛', 'left-facing_fist', 'fist_left'], ['🤜', 'right-facing_fist', 'fist_right'],
  ['👏', 'clap'], ['🙌', 'raised_hands'], ['👐', 'open_hands'], ['🤲', 'palms_up_together'], ['🤝', 'handshake'], ['🙏', 'pray'],
  ['✍️', 'writing_hand'], ['💅', 'nail_care'], ['🤳', 'selfie'], ['💪', 'muscle'], ['👂', 'ear'], ['👃', 'nose'], ['🧠', 'brain'],
  ['👀', 'eyes'], ['👁️', 'eye'], ['👅', 'tongue'], ['👄', 'lips'],
  /* Menschen */
  ['👶', 'baby'], ['👦', 'boy'], ['👧', 'girl'], ['👨', 'man'], ['👩', 'woman'], ['👴', 'older_man'], ['👵', 'older_woman'],
  ['🤷', 'shrug', 'person_shrugging'], ['🤦', 'face_palm', 'facepalm', 'person_facepalming'], ['🙋', 'raising_hand'],
  ['🙅', 'no_good'], ['🙆', 'ok_woman'], ['🙇', 'bow'], ['💁', 'information_desk_person', 'tipping_hand_person'],
  ['🏃', 'runner', 'running'], ['🚶', 'walking'], ['💃', 'dancer'], ['🕺', 'man_dancing'], ['🎅', 'santa'], ['👑', 'crown'],
  /* Tiere & Natur */
  ['🐶', 'dog'], ['🐱', 'cat'], ['🐭', 'mouse'], ['🐹', 'hamster'], ['🐰', 'rabbit'], ['🦊', 'fox_face'], ['🐻', 'bear'],
  ['🐼', 'panda_face'], ['🐨', 'koala'], ['🐯', 'tiger'], ['🦁', 'lion_face', 'lion'], ['🐮', 'cow'], ['🐷', 'pig'], ['🐸', 'frog'],
  ['🐵', 'monkey_face'], ['🐔', 'chicken'], ['🐧', 'penguin'], ['🐦', 'bird'], ['🐤', 'baby_chick'], ['🦅', 'eagle'], ['🦉', 'owl'],
  ['🦇', 'bat'], ['🐺', 'wolf'], ['🐴', 'horse'], ['🦄', 'unicorn_face', 'unicorn'], ['🐝', 'bee', 'honeybee'], ['🐛', 'bug'],
  ['🦋', 'butterfly'], ['🐌', 'snail'], ['🐞', 'beetle', 'lady_beetle'], ['🐢', 'turtle'], ['🐍', 'snake'], ['🐙', 'octopus'],
  ['🦀', 'crab'], ['🐠', 'tropical_fish'], ['🐟', 'fish'], ['🐬', 'dolphin'], ['🐳', 'whale'], ['🦈', 'shark'], ['🐘', 'elephant'],
  ['🦥', 'sloth'], ['🐾', 'feet', 'paw_prints'], ['🐕', 'dog2'], ['🐈', 'cat2'], ['💐', 'bouquet'], ['🌸', 'cherry_blossom'],
  ['🌹', 'rose'], ['🌻', 'sunflower'], ['🌷', 'tulip'], ['🌱', 'seedling'], ['🌲', 'evergreen_tree'], ['🌳', 'deciduous_tree'],
  ['🌴', 'palm_tree'], ['🌵', 'cactus'], ['🍀', 'four_leaf_clover'], ['🍁', 'maple_leaf'], ['🍂', 'fallen_leaf'], ['🍄', 'mushroom'],
  ['🌍', 'earth_africa'], ['🌎', 'earth_americas'], ['🌐', 'globe_with_meridians'], ['🌕', 'full_moon'], ['🌙', 'crescent_moon'],
  ['☀️', 'sunny'], ['⭐', 'star'], ['🌟', 'star2'], ['✨', 'sparkles'], ['⚡', 'zap'], ['🔥', 'fire'], ['🌈', 'rainbow'],
  ['☁️', 'cloud'], ['⛅', 'partly_sunny'], ['☔', 'umbrella_with_rain_drops'], ['❄️', 'snowflake'], ['☃️', 'snowman'],
  ['⛄', 'snowman_without_snow'], ['💧', 'droplet'], ['🌊', 'ocean'],
  /* Essen & Trinken */
  ['🍎', 'apple'], ['🍏', 'green_apple'], ['🍐', 'pear'], ['🍊', 'tangerine'], ['🍋', 'lemon'], ['🍌', 'banana'], ['🍉', 'watermelon'],
  ['🍇', 'grapes'], ['🍓', 'strawberry'], ['🍒', 'cherries'], ['🍑', 'peach'], ['🍍', 'pineapple'], ['🥑', 'avocado'],
  ['🍆', 'eggplant'], ['🍅', 'tomato'], ['🥕', 'carrot'], ['🌽', 'corn'], ['🌶️', 'hot_pepper'], ['🥒', 'cucumber'], ['🥦', 'broccoli'],
  ['🥔', 'potato'], ['🥐', 'croissant'], ['🍞', 'bread'], ['🥨', 'pretzel'], ['🧀', 'cheese_wedge', 'cheese'], ['🥚', 'egg'],
  ['🍳', 'fried_egg', 'cooking'], ['🥓', 'bacon'], ['🥞', 'pancakes'], ['🍔', 'hamburger'], ['🍟', 'fries'], ['🍕', 'pizza'],
  ['🌭', 'hotdog'], ['🥪', 'sandwich'], ['🌮', 'taco'], ['🌯', 'burrito'], ['🍲', 'stew'], ['🍝', 'spaghetti'], ['🍜', 'ramen'],
  ['🍣', 'sushi'], ['🍚', 'rice'], ['🍛', 'curry'], ['🍿', 'popcorn'], ['🍦', 'icecream'], ['🍨', 'ice_cream'], ['🍩', 'doughnut'],
  ['🍪', 'cookie'], ['🎂', 'birthday'], ['🍰', 'cake'], ['🧁', 'cupcake'], ['🍫', 'chocolate_bar'], ['🍬', 'candy'],
  ['🍭', 'lollipop'], ['☕', 'coffee'], ['🍵', 'tea'], ['🍺', 'beer'], ['🍻', 'beers'], ['🍷', 'wine_glass'], ['🍸', 'cocktail'],
  ['🍹', 'tropical_drink'], ['🍾', 'champagne'], ['🥂', 'clinking_glasses'], ['🥃', 'tumbler_glass'], ['🥤', 'cup_with_straw'],
  ['🍽️', 'knife_fork_plate'], ['🍴', 'fork_and_knife'], ['🥛', 'glass_of_milk', 'milk_glass'],
  /* Aktivitäten & Feiern */
  ['⚽', 'soccer'], ['🏀', 'basketball'], ['🏈', 'football'], ['⚾', 'baseball'], ['🎾', 'tennis'], ['🏐', 'volleyball'], ['⛳', 'golf'],
  ['🏆', 'trophy'], ['🏅', 'sports_medal', 'medal_sports'], ['🥇', 'first_place_medal'], ['🥈', 'second_place_medal'],
  ['🥉', 'third_place_medal'], ['🎯', 'dart'], ['🎮', 'video_game'], ['🎲', 'game_die'], ['🧩', 'jigsaw'], ['🎳', 'bowling'],
  ['🎨', 'art'], ['🎭', 'performing_arts'], ['🎤', 'microphone'], ['🎧', 'headphones'], ['🎵', 'musical_note'], ['🎶', 'notes'],
  ['🎸', 'guitar'], ['🎹', 'musical_keyboard'], ['🎺', 'trumpet'], ['🎻', 'violin'], ['🥁', 'drum_with_drumsticks', 'drum'],
  ['🎬', 'clapper'], ['🎫', 'ticket'], ['🎉', 'tada'], ['🎊', 'confetti_ball'], ['🎈', 'balloon'], ['🎁', 'gift'], ['🎀', 'ribbon'],
  ['🎄', 'christmas_tree'], ['🎃', 'jack_o_lantern'], ['🎆', 'fireworks'], ['🎇', 'sparkler'],
  /* Reisen & Orte */
  ['🚗', 'car', 'red_car'], ['🚕', 'taxi'], ['🚌', 'bus'], ['🚑', 'ambulance'], ['🚒', 'fire_engine'], ['🚓', 'police_car'],
  ['🚚', 'truck'], ['🚜', 'tractor'], ['🚲', 'bike'], ['✈️', 'airplane'], ['🚀', 'rocket'], ['🚁', 'helicopter'], ['🚢', 'ship'],
  ['⛵', 'boat', 'sailboat'], ['🚉', 'station'], ['🏠', 'house'], ['🏡', 'house_with_garden'], ['🏢', 'office'], ['🏥', 'hospital'],
  ['🏫', 'school'], ['🏨', 'hotel'], ['🏭', 'factory'], ['🚧', 'construction'], ['🚨', 'rotating_light'], ['🚦', 'vertical_traffic_light'],
  ['⛽', 'fuelpump'], ['🗺️', 'world_map'], ['⛰️', 'mountain'], ['🏕️', 'camping'], ['🏖️', 'beach_with_umbrella'],
  ['🏝️', 'desert_island'], ['🗿', 'moyai'], ['⛺', 'tent'], ['🌅', 'sunrise'], ['🏁', 'checkered_flag'],
  ['🚩', 'triangular_flag_on_post'], ['🏳️', 'waving_white_flag'], ['🏴', 'waving_black_flag'], ['🏳️‍🌈', 'rainbow-flag', 'rainbow_flag'],
  ['🇩🇪', 'flag-de', 'de'], ['🇦🇹', 'flag-at'], ['🇨🇭', 'flag-ch'], ['🇪🇺', 'flag-eu'], ['🇺🇸', 'flag-us', 'us'],
  ['🇬🇧', 'flag-gb', 'gb', 'uk'], ['🇫🇷', 'flag-fr', 'fr'], ['🇮🇹', 'flag-it', 'it'], ['🇪🇸', 'flag-es', 'es'],
  /* Gegenstände */
  ['⌚', 'watch'], ['📱', 'iphone'], ['📲', 'calling'], ['💻', 'computer'], ['⌨️', 'keyboard'], ['🖥️', 'desktop_computer'],
  ['🖨️', 'printer'], ['🖱️', 'three_button_mouse'], ['💾', 'floppy_disk'], ['💿', 'cd'], ['📷', 'camera'], ['📸', 'camera_with_flash'],
  ['📹', 'video_camera'], ['🎥', 'movie_camera'], ['📺', 'tv'], ['📻', 'radio'], ['📞', 'telephone_receiver'], ['☎️', 'phone', 'telephone'],
  ['📠', 'fax'], ['🔋', 'battery'], ['🔌', 'electric_plug'], ['💡', 'bulb'], ['🔦', 'flashlight'], ['🕯️', 'candle'], ['💰', 'moneybag'],
  ['💵', 'dollar'], ['💶', 'euro'], ['💳', 'credit_card'], ['💎', 'gem'], ['🔧', 'wrench'], ['🔨', 'hammer'],
  ['🛠️', 'hammer_and_wrench'], ['🔩', 'nut_and_bolt'], ['⚙️', 'gear'], ['💣', 'bomb'], ['🔪', 'hocho', 'knife'], ['🛡️', 'shield'],
  ['🔮', 'crystal_ball'], ['💊', 'pill'], ['💉', 'syringe'], ['🧬', 'dna'], ['🔬', 'microscope'], ['🔭', 'telescope'], ['🧹', 'broom'],
  ['🔑', 'key'], ['🗝️', 'old_key'], ['🚪', 'door'], ['🛏️', 'bed'], ['🧸', 'teddy_bear'], ['🛒', 'shopping_trolley'],
  ['✉️', 'envelope', 'email'], ['📧', 'e-mail'], ['📨', 'incoming_envelope'], ['📩', 'envelope_with_arrow'], ['📤', 'outbox_tray'],
  ['📥', 'inbox_tray'], ['📦', 'package'], ['📫', 'mailbox'], ['📮', 'postbox'], ['📜', 'scroll'], ['📄', 'page_facing_up'],
  ['📃', 'page_with_curl'], ['📑', 'bookmark_tabs'], ['📊', 'bar_chart'], ['📈', 'chart_with_upwards_trend'],
  ['📉', 'chart_with_downwards_trend'], ['🗒️', 'spiral_note_pad'], ['🗓️', 'spiral_calendar_pad'], ['📆', 'calendar'], ['📅', 'date'],
  ['📇', 'card_index'], ['🗂️', 'card_index_dividers'], ['📁', 'file_folder'], ['📂', 'open_file_folder'], ['📋', 'clipboard'],
  ['📌', 'pushpin'], ['📍', 'round_pushpin'], ['📎', 'paperclip'], ['📏', 'straight_ruler'], ['📐', 'triangular_ruler'],
  ['✂️', 'scissors'], ['🗑️', 'wastebasket'], ['🔒', 'lock'], ['🔓', 'unlock'], ['🔐', 'closed_lock_with_key'], ['✏️', 'pencil2'],
  ['✒️', 'black_nib'], ['📝', 'memo', 'pencil'], ['💼', 'briefcase'], ['📚', 'books'], ['📖', 'book', 'open_book'], ['📓', 'notebook'],
  ['📒', 'ledger'], ['📰', 'newspaper'], ['🏷️', 'label'], ['🔖', 'bookmark'], ['🔗', 'link'], ['🔍', 'mag'], ['🔎', 'mag_right'],
  ['⌛', 'hourglass'], ['⏳', 'hourglass_flowing_sand'], ['⏰', 'alarm_clock'], ['⏱️', 'stopwatch'], ['⏲️', 'timer_clock'],
  ['🔔', 'bell'], ['🔕', 'no_bell'], ['📢', 'loudspeaker'], ['📣', 'mega'], ['🔈', 'speaker'], ['🔉', 'sound'], ['🔊', 'loud_sound'],
  ['🔇', 'mute'], ['🎓', 'mortar_board'], ['🎩', 'tophat'], ['👓', 'eyeglasses'], ['🕶️', 'dark_sunglasses'], ['👔', 'necktie'],
  ['👕', 'shirt', 'tshirt'], ['👖', 'jeans'], ['👗', 'dress'], ['👟', 'athletic_shoe'], ['👞', 'mans_shoe', 'shoe'],
  ['🎒', 'school_satchel'], ['👜', 'handbag'], ['💍', 'ring'], ['💄', 'lipstick'], ['🧲', 'magnet'], ['🧪', 'test_tube'],
  ['🧾', 'receipt'],
  /* Symbole */
  ['✅', 'white_check_mark'], ['✔️', 'heavy_check_mark'], ['☑️', 'ballot_box_with_check'], ['❌', 'x'],
  ['❎', 'negative_squared_cross_mark'], ['➕', 'heavy_plus_sign'], ['➖', 'heavy_minus_sign'], ['➗', 'heavy_division_sign'],
  ['✖️', 'heavy_multiplication_x'], ['❗', 'exclamation', 'heavy_exclamation_mark'], ['❕', 'grey_exclamation'], ['❓', 'question'],
  ['❔', 'grey_question'], ['‼️', 'bangbang'], ['⁉️', 'interrobang'], ['⚠️', 'warning'], ['⛔', 'no_entry'], ['🚫', 'no_entry_sign'],
  ['🛑', 'octagonal_sign', 'stop_sign'], ['♻️', 'recycle'], ['⚪', 'white_circle'], ['⚫', 'black_circle'], ['🔴', 'red_circle'],
  ['🔵', 'large_blue_circle', 'blue_circle'], ['🟠', 'large_orange_circle'], ['🟡', 'large_yellow_circle'], ['🟢', 'large_green_circle'],
  ['🟣', 'large_purple_circle'], ['🟥', 'large_red_square'], ['🟩', 'large_green_square'], ['🟨', 'large_yellow_square'],
  ['🟦', 'large_blue_square'], ['⬛', 'black_large_square'], ['⬜', 'white_large_square'], ['🔺', 'small_red_triangle'],
  ['🔻', 'small_red_triangle_down'], ['🔶', 'large_orange_diamond'], ['🔷', 'large_blue_diamond'], ['🔸', 'small_orange_diamond'],
  ['🔹', 'small_blue_diamond'], ['➡️', 'arrow_right'], ['⬅️', 'arrow_left'], ['⬆️', 'arrow_up'], ['⬇️', 'arrow_down'],
  ['↗️', 'arrow_upper_right'], ['↘️', 'arrow_lower_right'], ['↙️', 'arrow_lower_left'], ['↖️', 'arrow_upper_left'],
  ['↔️', 'left_right_arrow'], ['↕️', 'arrow_up_down'], ['🔄', 'arrows_counterclockwise'], ['🔃', 'arrows_clockwise'],
  ['↩️', 'leftwards_arrow_with_hook'], ['↪️', 'arrow_right_hook'], ['▶️', 'arrow_forward'], ['◀️', 'arrow_backward'],
  ['⏩', 'fast_forward'], ['⏪', 'rewind'], ['⏸️', 'double_vertical_bar', 'pause_button'], ['🔁', 'repeat'],
  ['🔀', 'twisted_rightwards_arrows'], ['🆕', 'new'], ['🆓', 'free'], ['🆙', 'up'], ['🆒', 'cool'], ['🆗', 'ok'], ['🆘', 'sos'],
  ['🔝', 'top'], ['🔜', 'soon'], ['🔙', 'back'], ['🔚', 'end'], ['ℹ️', 'information_source'], ['©️', 'copyright'], ['®️', 'registered'],
  ['™️', 'tm'], ['#️⃣', 'hash'], ['0️⃣', 'zero'], ['1️⃣', 'one'], ['2️⃣', 'two'], ['3️⃣', 'three'], ['4️⃣', 'four'], ['5️⃣', 'five'],
  ['6️⃣', 'six'], ['7️⃣', 'seven'], ['8️⃣', 'eight'], ['9️⃣', 'nine'], ['🔟', 'keycap_ten'], ['🅰️', 'a'], ['🅱️', 'b'],
  ['🅿️', 'parking'], ['☮️', 'peace_symbol'], ['☯️', 'yin_yang'], ['♾️', 'infinity'], ['☢️', 'radioactive_sign', 'radioactive'],
  ['✳️', 'eight_spoked_asterisk'], ['❇️', 'sparkle'], ['🔰', 'beginner'], ['⭕', 'o'], ['〰️', 'wavy_dash'], ['➰', 'curly_loop'],
  ['💲', 'heavy_dollar_sign'], ['🆚', 'vs'], ['♿', 'wheelchair'], ['🚭', 'no_smoking'], ['📴', 'mobile_phone_off'],
  ['📳', 'vibration_mode'], ['📶', 'signal_strength'], ['🔘', 'radio_button'],
];

const NAME_TO_EMOJI = new Map<string, string>();
const EMOJI_TO_NAME = new Map<string, string>();
for (const [emoji, ...names] of TABLE) {
  for (const n of names) if (!NAME_TO_EMOJI.has(n!)) NAME_TO_EMOJI.set(n!, emoji!);
  const key = emoji!.replace(/️/g, '');
  if (!EMOJI_TO_NAME.has(key)) EMOJI_TO_NAME.set(key, names[0]!);
}

/** Hautfarben: Mattermost hängt _skin_tone_2 … _skin_tone_6 an (Slack-Stil: _tone1 … _tone5) */
const SKIN_TONES = ['🏻', '🏼', '🏽', '🏾', '🏿'];

/** Emoji zu einem Kurzcode-Namen (ohne Doppelpunkte); undefined = unbekannt */
export function emojiForShortcode(name: string): string | undefined {
  const n = name.toLowerCase();
  const direct = NAME_TO_EMOJI.get(n);
  if (direct) return direct;
  const m = /^(.+?)(?:_skin_tone_([2-6])|_tone([1-5]))$/.exec(n);
  if (!m) return undefined;
  const base = NAME_TO_EMOJI.get(m[1]!);
  const idx = m[2] ? Number(m[2]) - 2 : Number(m[3]) - 1;
  return base ? base.replace(/️/g, '') + SKIN_TONES[idx]! : undefined;
}

/** Kurzcode-Name zu einem Emoji (für Reaktionen an Mattermost); undefined = unbekannt */
export function shortcodeForEmoji(emoji: string): string | undefined {
  const plain = emoji.replace(/️/g, '');
  const direct = EMOJI_TO_NAME.get(plain);
  if (direct) return direct;
  const tone = SKIN_TONES.findIndex((t) => plain.endsWith(t));
  if (tone < 0) return undefined;
  const base = EMOJI_TO_NAME.get(plain.slice(0, -SKIN_TONES[tone]!.length));
  return base ? `${base}_skin_tone_${tone + 2}` : undefined;
}

/** :kurzcode: im Text durch Emojis ersetzen – Code (`…`, ```…```) bleibt unverändert */
export function replaceShortcodes(text: string): string {
  if (!text.includes(':')) return text;
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((part, i) => (i % 2 ? part : part.replace(/(?<![\w]):([a-z0-9_+-]{1,50}):/gi, (all, name: string) => emojiForShortcode(name) ?? all)))
    .join('');
}

/** Text-Smileys, die beim Tippen im Chat durch Emojis ersetzt werden */
const SMILEY_TABLE: [string, string[]][] = [
  ['🙂', [':)', ':-)', '=)']],
  ['😉', [';)', ';-)']],
  ['😄', [':D', ':-D', '=D']],
  ['😆', ['xD', 'XD']],
  ['🙁', [':(', ':-(']],
  ['😢', [":'(", ":'-("]],
  ['😛', [':P', ':-P', ':p', ':-p']],
  ['😜', [';P', ';-P', ';p', ';-p']],
  ['😮', [':O', ':-O', ':o', ':-o']],
  ['😕', [':/', ':-/']],
  ['😐', [':|', ':-|']],
  ['😎', ['B-)', '8-)']],
  ['😘', [':*', ':-*']],
  ['😇', ['O:)', 'O:-)']],
  ['❤️', ['<3']],
  ['💔', ['</3']],
];

export const TEXT_SMILEYS = new Map<string, string>(SMILEY_TABLE.flatMap(([emoji, codes]) => codes.map((c) => [c, emoji] as [string, string])));
