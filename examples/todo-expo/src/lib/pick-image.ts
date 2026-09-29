import * as ImagePicker from 'expo-image-picker'

/**
 * The shared image pick (add row + edit modal both stage a device uri this way).
 * preferredAssetRepresentationMode 'compatible' makes iOS transcode HEIC to a
 * web-renderable JPEG inside the picker itself, so the web peers' <img>
 * (Vue/React) can display it.
 */
export async function pickImageUri(): Promise<string | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    quality: 0.6,
    preferredAssetRepresentationMode:
      ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
  })

  return result.assets?.[0]?.uri ?? null
}
