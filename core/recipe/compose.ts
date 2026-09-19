/** Public composition entry point. The implementation remains the proven pure composer. */
export {
  compose,
  composeParts,
  findBlock,
  findTagBlock,
  settingsOf,
  ratingOf,
  previewText,
  DEFAULT_SETTINGS,
  TAG_BLOCKS,
  MEMBER_BLOCKS,
  UC_HEAVY,
  UC_LIGHT,
  SFW_GUARDS,
  NSFW_TECH_NEGATIVES,
} from "../../lib/composer";
export type { Settings, ComposeParts } from "../../lib/composer";
