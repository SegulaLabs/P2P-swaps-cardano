import { Settings } from "@/components/Settings";

/** /settings — choose Blockfrost or Koios and set the relevant key. */
export default function SettingsPage() {
  return (
    <>
      <div className="page-title">
        <h1>Settings</h1>
      </div>
      <Settings />
    </>
  );
}
