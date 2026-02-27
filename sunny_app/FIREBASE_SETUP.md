# Firebase Cloud Messaging Setup for Sunny

This document covers every manual step required before the push notification code
in `VoiceAgent/` will compile and run. Steps marked **[Xcode]** must be done inside
Xcode; steps marked **[Firebase console]** require a browser.

---

## Prerequisites

- A Google account with access to Firebase Console
- Xcode 15 or later
- An Apple Developer account with the Bundle ID for Sunny (check `sunnyDebug.entitlements`)
- An APNs `.p8` authentication key downloaded from the Apple Developer portal
  (Certificates, Identifiers & Profiles → Keys → + → Apple Push Notifications service)

---

## 1. Create the Firebase project

**[Firebase console]** https://console.firebase.google.com

1. Click **Add project** → name it `Sunny`.
2. Disable Google Analytics if not needed, then click **Create project**.

---

## 2. Add the iOS app to the project

**[Firebase console]**

1. In your Sunny project, click **Add app** → iOS icon.
2. Enter the Bundle ID from `sunny_app/VoiceAgent/sunnyDebug.entitlements`
   (e.g. `com.yourteam.sunny`).
3. Enter an optional app nickname (`Sunny iOS`).
4. Click **Register app**.
5. Download `GoogleService-Info.plist` and place it at:
   ```
   sunny_app/VoiceAgent/GoogleService-Info.plist
   ```
6. In Xcode, drag the plist into the `VoiceAgent` group and ensure
   **Target Membership: VoiceAgent** is checked.
7. Skip the remaining Firebase SDK steps in the web wizard — we use SPM below.

---

## 3. Upload the APNs authentication key

**[Firebase console]** Project Settings → Cloud Messaging → Apple app configuration

1. Under **APNs Authentication Key**, click **Upload**.
2. Upload the `.p8` key file downloaded from the Apple Developer portal.
3. Enter the **Key ID** and **Team ID** (both visible in the Apple Developer portal).
4. Click **Upload**.

This allows Firebase to send pushes on your behalf via APNs.

---

## 4. Enable Cloud Messaging API

**[Firebase console]** Project Settings → Cloud Messaging

Ensure **Firebase Cloud Messaging API (V1)** is listed as **Enabled**.
If it shows **Disabled**, click the menu (⋮) and enable it.

---

## 5. Add the Firebase iOS SDK via Swift Package Manager

**[Xcode]** File → Add Package Dependencies...

1. Enter the repository URL: `https://github.com/firebase/firebase-ios-sdk`
2. Set **Dependency Rule** to **Up to Next Major Version** starting at the latest stable
   release (e.g. `11.x.x`).
3. Click **Add Package**.
4. In the **Choose Package Products** dialog, select only:
   - `FirebaseCore`
   - `FirebaseMessaging`
5. Ensure both are added to the **VoiceAgent** target.
6. Click **Add Package**.

The `import FirebaseCore` and `import FirebaseMessaging` errors in Xcode will
disappear once this step completes.

---

## 6. Add Push Notifications capability

**[Xcode]** Select the `VoiceAgent` target → Signing & Capabilities → + Capability

1. Search for **Push Notifications** and double-click to add.
2. Xcode will add `aps-environment` to `VoiceAgent/sunny.entitlements` automatically.
3. Build the project to verify there are no errors (`Cmd+B`).

---

## 7. Set Supabase secrets for NOTIFY-2

When the `send-reminders` edge function is implemented (NOTIFY-2), it will need the
FCM server credentials. Set them via the Supabase CLI:

```bash
supabase secrets set FIREBASE_PROJECT_ID=<your-project-id>
supabase secrets set FIREBASE_SERVICE_ACCOUNT_KEY='<json-content>'
```

The service account key is found at:
Firebase console → Project Settings → Service accounts → Generate new private key.

---

## 8. Deploy the updated livekit-token edge function

After Step 1 of the NOTIFY-1 implementation (trigger metadata in participant metadata):

```bash
supabase functions deploy livekit-token
```

---

## 9. Verify token registration on a real device

FCM tokens require a **real device** (not the simulator).

1. Build and run Sunny on a physical iPhone.
2. Accept the notification permission prompt (or check Console.app for the FCM token log).
3. In Supabase Dashboard → Table Editor → `device_tokens`, verify a row appeared
   for your test user with `platform = 'ios'`.

---

## 10. Send a test push from Firebase console

**[Firebase console]** Cloud Messaging → New campaign → Notifications

1. Enter a notification title and body.
2. Under **Target** → **Test on device**, paste the FCM token from step 9.
3. Click **Test**.
4. The notification should appear on the device within a few seconds.

---

## 11. Test notification tap auto-connect

**Tap while app is backgrounded:**
1. Open Sunny, then press the home button to background it.
2. Send a test push (step 10).
3. Tap the notification banner.
4. Sunny should foreground and auto-connect to a LiveKit session.

**Tap from terminated (cold start):**
1. Force-quit Sunny from the app switcher.
2. Send a test push (step 10).
3. Tap the notification.
4. Sunny should launch and auto-connect with a reminder-aware greeting.

**Permission denied graceful fallback:**
1. In iOS Settings → Notifications → Sunny, disable notifications.
2. Relaunch Sunny — voice sessions still work normally; no crash.

---

## Troubleshooting

| Symptom | Likely cause |
|---------|-------------|
| `No such module 'FirebaseMessaging'` | SPM package not added (step 5) |
| `GoogleService-Info.plist not found` | Plist not added to Xcode target (step 2, step 6) |
| Notifications not delivered | APNs key not uploaded (step 3) or capability missing (step 6) |
| `device_tokens` row missing | `save-device-token` edge function returned an error — check Supabase logs |
| App connects but agent uses generic greeting | `reminder_id` not in notification payload or reminder not found in DB |
