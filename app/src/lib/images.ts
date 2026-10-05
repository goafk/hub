// Pick or shoot a photo, shrink it for the agent (long side ≤ 1568px, JPEG), return base64.
import * as ImagePicker from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";

export type Attachment = { uri: string; mimeType: string; data: string; width: number; height: number };

const MAX_SIDE = 1568; // what vision models use at full detail

/** Shrinks an image file (e.g. one shared from another app) the same way as picked photos. */
export async function shrinkUri(uri: string, width = 4000, height = 4000): Promise<Attachment> {
  return shrink({ uri, width, height } as ImagePicker.ImagePickerAsset);
}

async function shrink(asset: ImagePicker.ImagePickerAsset): Promise<Attachment> {
  const long = Math.max(asset.width, asset.height);
  const ctx = ImageManipulator.manipulate(asset.uri);
  if (long > MAX_SIDE) ctx.resize(asset.width >= asset.height ? { width: MAX_SIDE } : { height: MAX_SIDE });
  const ref = await ctx.renderAsync();
  const out = await ref.saveAsync({ format: SaveFormat.JPEG, compress: 0.72, base64: true });
  return { uri: out.uri, mimeType: "image/jpeg", data: out.base64 ?? "", width: out.width, height: out.height };
}

export async function pickImages(source: "library" | "camera"): Promise<Attachment[]> {
  if (source === "camera") {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) throw new Error("Camera permission is needed to take a photo.");
    const r = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 1 });
    return r.canceled ? [] : Promise.all(r.assets.map(shrink));
  }
  const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsMultipleSelection: true, selectionLimit: 6, quality: 1 });
  return r.canceled ? [] : Promise.all(r.assets.map(shrink));
}
