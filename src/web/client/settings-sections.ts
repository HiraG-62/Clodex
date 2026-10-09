export type SettingsItem = "rolePreset" | "sandbox" | "limits" | "sendKey" | "push" | "language" | "mobileConnect" | "guiUpdate";
export type SettingsSectionId = "project" | "device" | "clodex";
export interface SettingsSection {
  id: SettingsSectionId;
  items: SettingsItem[];
}

export function settingsSections({
  mobile,
  pushSupported,
  guiConnected,
}: {
  mobile: boolean;
  pushSupported: boolean;
  guiConnected: boolean;
}): SettingsSection[] {
  const sections: SettingsSection[] = [{ id: "project", items: ["rolePreset", "sandbox", "limits"] }];
  const device: SettingsItem[] = [];
  if (!mobile) device.push("sendKey");
  if (pushSupported) device.push("push");
  if (device.length) sections.push({ id: "device", items: device });
  sections.push({ id: "clodex", items: guiConnected ? ["language", "mobileConnect", "guiUpdate"] : ["language", "mobileConnect"] });
  return sections;
}
