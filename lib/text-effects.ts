/** Separate text fragments with an empty line, as required by NAI Text rendering. */
export const TEXT_RENDER_LIMIT = 750;
export const renderText = (entries: readonly { text: string }[]) =>
  entries.map(entry => entry.text.trim()).filter(Boolean).join("\n\n");

export const TEXT_EFFECTS = {
  speech: { label: "말풍선", instruction: "inside a speech bubble", examples: ["안녕!", "Hello!", "こんにちは！"] },
  sound: { label: "의성어", instruction: "as sound effect lettering", examples: ["쿵!", "Bang!", "ドキドキ"] },
  motion: { label: "의태어", instruction: "as mimetic lettering describing motion or mood", examples: ["반짝", "두근두근", "キラキラ"] },
} as const;
