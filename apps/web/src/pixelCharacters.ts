import { PIXEL_SKIN_IDS, type PixelSkinId } from "@relaycode/shared";

export interface PixelSkin {
  id: PixelSkinId;
  label: string;
  src: string;
}

const LABELS: Record<PixelSkinId, string> = {
  bear: "Bear",
  pig: "Pig",
  penguin: "Penguin",
  bunny: "Bunny",
  ox: "Ox",
  fox: "Fox",
  frog: "Frog",
  dog: "Dog",
  ghost: "Ghost",
  raccoon: "Raccoon",
  cat: "Cat",
  monkey: "Monkey",
};

export const PIXEL_SKINS: PixelSkin[] = PIXEL_SKIN_IDS.map((id) => ({
  id,
  label: LABELS[id],
  src: `/pixel-skins/${id}.png`,
}));

export const DEFAULT_PIXEL_SKIN: PixelSkinId = PIXEL_SKINS[0]!.id;

export function getPixelSkin(id?: string | null): PixelSkin {
  return PIXEL_SKINS.find((skin) => skin.id === id) ?? PIXEL_SKINS[0]!;
}
