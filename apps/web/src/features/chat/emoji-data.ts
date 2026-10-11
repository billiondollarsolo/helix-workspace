/* The emoji offered by the Chat reaction and composer pickers, grouped by
   category. Each entry is "<emoji> <name>"; the name is the accessible label
   and what the picker's search matches. */

export interface EmojiEntry {
  readonly emoji: string;
  readonly name: string;
}

export interface EmojiCategory {
  readonly id: string;
  readonly label: string;
  readonly emoji: readonly EmojiEntry[];
}

/** One tap away on every message: the most common reactions. */
export const QUICK_REACTIONS: readonly EmojiEntry[] = [
  { emoji: "👍", name: "thumbs up" },
  { emoji: "❤️", name: "red heart" },
  { emoji: "😂", name: "face with tears of joy" },
  { emoji: "🎉", name: "party popper" },
  { emoji: "🙏", name: "folded hands" },
  { emoji: "👀", name: "eyes" },
];

const RAW: readonly (readonly [string, string, readonly string[]])[] = [
  [
    "smileys",
    "Smileys",
    [
      "😀 grinning face",
      "😃 smiling face with big eyes",
      "😄 smiling face with smiling eyes",
      "😁 beaming face",
      "😆 laughing",
      "😅 grinning face with sweat",
      "🤣 rolling on the floor laughing",
      "😂 face with tears of joy",
      "🙂 slightly smiling face",
      "😉 winking face",
      "😊 smiling face with blush",
      "😇 smiling face with halo",
      "🥰 smiling face with hearts",
      "😍 heart eyes",
      "🤩 star struck",
      "😘 face blowing a kiss",
      "😋 face savoring food",
      "😛 face with tongue",
      "😜 winking face with tongue",
      "🤪 zany face",
      "🤗 hugging face",
      "🤭 face with hand over mouth",
      "🤫 shushing face",
      "🤔 thinking face",
      "🤐 zipper mouth face",
      "😐 neutral face",
      "😑 expressionless face",
      "😶 face without mouth",
      "😏 smirking face",
      "😒 unamused face",
      "🙄 face with rolling eyes",
      "😬 grimacing face",
      "😌 relieved face",
      "😔 pensive face",
      "😪 sleepy face",
      "😴 sleeping face",
      "😷 face with medical mask",
      "🤒 face with thermometer",
      "🤯 exploding head",
      "🥳 partying face",
      "😎 smiling face with sunglasses",
      "🤓 nerd face",
      "😕 confused face",
      "😟 worried face",
      "😮 face with open mouth",
      "😲 astonished face",
      "🥺 pleading face",
      "😢 crying face",
      "😭 loudly crying face",
      "😱 face screaming in fear",
      "😤 face with steam from nose",
      "😡 pouting face",
      "😠 angry face",
      "🤦 person facepalming",
      "🤷 person shrugging",
    ],
  ],
  [
    "gestures",
    "Gestures",
    [
      "👍 thumbs up",
      "👎 thumbs down",
      "👌 ok hand",
      "✌️ victory hand",
      "🤞 crossed fingers",
      "🤟 love you gesture",
      "🤘 sign of the horns",
      "👈 backhand index pointing left",
      "👉 backhand index pointing right",
      "👆 backhand index pointing up",
      "👇 backhand index pointing down",
      "☝️ index pointing up",
      "✋ raised hand",
      "👋 waving hand",
      "🤙 call me hand",
      "💪 flexed biceps",
      "👏 clapping hands",
      "🙌 raising hands",
      "👐 open hands",
      "🤝 handshake",
      "🙏 folded hands",
      "✍️ writing hand",
      "👀 eyes",
      "🧠 brain",
    ],
  ],
  [
    "hearts",
    "Hearts and symbols",
    [
      "❤️ red heart",
      "🧡 orange heart",
      "💛 yellow heart",
      "💚 green heart",
      "💙 blue heart",
      "💜 purple heart",
      "🖤 black heart",
      "💔 broken heart",
      "💯 hundred points",
      "✅ check mark button",
      "☑️ check box with check",
      "✔️ check mark",
      "❌ cross mark",
      "❗ exclamation mark",
      "❓ question mark",
      "⚠️ warning",
      "🚫 prohibited",
      "⭐ star",
      "🌟 glowing star",
      "✨ sparkles",
      "⚡ high voltage",
      "🔥 fire",
      "💡 light bulb",
      "📌 pushpin",
      "🔔 bell",
      "➕ plus",
      "➖ minus",
    ],
  ],
  [
    "celebration",
    "Celebration",
    [
      "🎉 party popper",
      "🎊 confetti ball",
      "🎈 balloon",
      "🎂 birthday cake",
      "🎁 wrapped gift",
      "🏆 trophy",
      "🥇 first place medal",
      "🏅 sports medal",
      "🎯 direct hit",
      "🚀 rocket",
      "🙌 raising hands",
      "🍾 bottle with popping cork",
      "🥂 clinking glasses",
    ],
  ],
  [
    "nature",
    "Nature and food",
    [
      "🐶 dog face",
      "🐱 cat face",
      "🦊 fox",
      "🐻 bear",
      "🐼 panda",
      "🐨 koala",
      "🦁 lion",
      "🐸 frog",
      "🐢 turtle",
      "🦄 unicorn",
      "🐝 honeybee",
      "🌱 seedling",
      "🌲 evergreen tree",
      "🌸 cherry blossom",
      "🌻 sunflower",
      "🌈 rainbow",
      "☀️ sun",
      "🌙 crescent moon",
      "❄️ snowflake",
      "☕ hot beverage",
      "🍵 teacup",
      "🍕 pizza",
      "🍔 hamburger",
      "🌮 taco",
      "🍣 sushi",
      "🍩 doughnut",
      "🍪 cookie",
      "🍎 red apple",
      "🍋 lemon",
      "🥑 avocado",
    ],
  ],
  [
    "objects",
    "Work and objects",
    [
      "💻 laptop",
      "🖥️ desktop computer",
      "📱 mobile phone",
      "⌨️ keyboard",
      "📅 calendar",
      "🗓️ spiral calendar",
      "📎 paperclip",
      "📝 memo",
      "📄 page facing up",
      "📁 file folder",
      "📊 bar chart",
      "📈 chart increasing",
      "📉 chart decreasing",
      "🔍 magnifying glass",
      "🔒 locked",
      "🔑 key",
      "🛠️ hammer and wrench",
      "⚙️ gear",
      "🐛 bug",
      "📦 package",
      "✉️ envelope",
      "📣 megaphone",
      "⏰ alarm clock",
      "⏳ hourglass",
      "🕐 one o'clock",
      "☎️ telephone",
      "🎧 headphone",
      "📷 camera",
      "🏠 house",
      "✈️ airplane",
      "🚗 car",
    ],
  ],
];

export const EMOJI_CATEGORIES: readonly EmojiCategory[] = RAW.map(([id, label, entries]) => ({
  id,
  label,
  emoji: entries.map((entry) => {
    const space = entry.indexOf(" ");
    return { emoji: entry.slice(0, space), name: entry.slice(space + 1) };
  }),
}));

/** Every emoji once, for search. */
export function searchEmoji(query: string): readonly EmojiEntry[] {
  const needle = query.trim().toLowerCase();
  const seen = new Set<string>();
  const results: EmojiEntry[] = [];
  for (const category of EMOJI_CATEGORIES) {
    for (const entry of category.emoji) {
      if (seen.has(entry.emoji)) continue;
      if (needle.length > 0 && !entry.name.split(" ").some((word) => word.startsWith(needle))) {
        continue;
      }
      seen.add(entry.emoji);
      results.push(entry);
    }
  }
  return results;
}
