# Screen sharing for Sunny: a complete technical plan

**Sunny can currently only guess what seniors see on their iPhone screen — screen sharing changes that.** By piping a ReplayKit Broadcast Extension through LiveKit to a vision-capable Python agent, Sunny gains real-time sight of the senior's screen and delivers precise, contextual guidance instead of generic instructions. This document provides a complete JIRA-style epic with architecture decisions, cost analysis, and implementation-ready tickets.

The core architectural decision is an **agent handoff pattern**: Sunny's lightweight voice agent (GPT-4o-mini) hands off to a vision-enabled agent (GPT-4o) when screen sharing activates, then hands back when it stops. This keeps voice-only sessions cheap and fast while unlocking full vision capabilities on demand — at roughly **$0.15–0.20 per 5-minute screen sharing session**.

---

## Architecture overview and key decisions

The screen sharing pipeline flows from the senior's iPhone through four stages: **ReplayKit capture → LiveKit WebRTC transport → Python agent frame processing → Vision LLM analysis**. Each stage has specific constraints that shaped the architecture.

```
┌─────────────────────────────────────────────────────────────────────┐
│                        iOS DEVICE                                   │
│                                                                     │
│  ┌──────────────┐    App Group IPC    ┌───────────────────────┐    │
│  │  Broadcast    │◄──────────────────►│    Sunny iOS App       │    │
│  │  Extension    │   (frames/config)  │                        │    │
│  │ LKSampleHandler│                   │  ┌──────────────────┐ │    │
│  │  50MB limit   │                    │  │ LiveKit Room      │ │    │
│  └──────┬────────┘                    │  │  - Audio track    │ │    │
│         │ H.264 frames                │  │  - Screen track   │ │    │
│         └─────────────────────────────┼──┤  (published here) │ │    │
│                                       │  └────────┬─────────┘ │    │
│                                       └───────────┼───────────┘    │
└───────────────────────────────────────────────────┼────────────────┘
                                                    │ WebRTC
                                                    ▼
┌───────────────────────────────────────────────────────────────────┐
│                      LIVEKIT CLOUD SFU                            │
└───────────────────────────────────┬───────────────────────────────┘
                                    │
                                    ▼
┌───────────────────────────────────────────────────────────────────┐
│                     PYTHON AGENT SERVER                           │
│                                                                   │
│  ┌─────────────────────┐     handoff      ┌────────────────────┐ │
│  │   SunnyAgent        │◄────────────────►│ SunnyVisionAgent   │ │
│  │   (voice-only)      │                  │ (screen + voice)   │ │
│  │   GPT-4o-mini/Haiku │                  │ GPT-4o + frames    │ │
│  │   Deepgram STT      │                  │ Deepgram STT       │ │
│  │   Cartesia TTS      │                  │ Cartesia TTS       │ │
│  └─────────────────────┘                  └────────┬───────────┘ │
│                                                    │             │
│                         ┌──────────────────────────┘             │
│                         ▼                                        │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Workflow Engine + Screen Validator                        │   │
│  │  - Embedding match → structured workflow → step validate  │   │
│  │  - No match → freeform vision guidance                    │   │
│  └──────────────────────────────────────────────────────────┘   │
│                         │                                        │
│                         ▼                                        │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Supabase (PostgreSQL + pgvector)                         │   │
│  │  ~900 workflow JSONs, user facts, conversations           │   │
│  └──────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

### Why agent handoff beats the alternatives

Three architectural options were evaluated. **Option A** — keeping one agent and swapping the model — introduces complexity around mid-conversation model changes and doesn't cleanly separate vision-specific prompting. **Option B** — a two-model pipeline where Gemini Flash generates text descriptions fed to the conversation model — adds **200–500ms of latency** per turn and loses visual nuance. **Option C** — LiveKit's native agent handoff — wins because it provides clean lifecycle management, separate system prompts optimized for each mode, context preservation via `chat_ctx`, and zero latency overhead from intermediate processing.

The handoff works through LiveKit's `session.update_agent()` API. When the Python agent detects a video track subscription (screen share started), it triggers a handoff from `SunnyAgent` to `SunnyVisionAgent`, passing the full conversation history. The reverse handoff fires when the track is unpublished. **Chat context flows seamlessly** — the senior experiences one continuous conversation.

### Why GPT-4o for vision (not Gemini Flash)

While **Gemini 2.0 Flash costs 10–20× less** per session ($0.01 vs $0.17), GPT-4o was selected as the primary vision model for three reasons. First, **accuracy on iOS UI elements** — GPT-4o scores highest on OCR, button identification, and instruction generation quality, which directly impacts whether a confused 78-year-old can follow Sunny's guidance. Second, **spatial reasoning** — directing seniors to "the blue button in the top right" requires reliable spatial understanding where GPT-4o and Claude Sonnet lead. Third, **ecosystem alignment** — the existing agent already uses OpenAI models, avoiding a new provider dependency. Gemini 2.0 Flash is the recommended cost-optimization path once the feature is validated, achievable by simply swapping the model parameter.

---

## Cost analysis per screen sharing session

A typical screen sharing session lasts **3–7 minutes** as Sunny guides a senior through a task. Using optimized frame sampling (only analyzing frames when screen content changes, approximately **30–40 frames per session**), here are the projected costs:

| Model | Cost per frame (high detail) | Cost per session (5 min) | Latency (TTFT + 100 tokens) |
|---|---|---|---|
| **GPT-4o** (recommended) | $0.004 | **$0.15–0.20** | 1.0–2.0s |
| GPT-4o-mini | $0.001 | $0.04–0.06 | 0.8–1.5s |
| Claude 3.5 Sonnet | $0.005 | $0.18–0.25 | 1.5–2.5s |
| Gemini 2.0 Flash | $0.0002 | **$0.01–0.02** | 0.5–1.0s |
| Gemini 2.5 Flash | $0.0004 | $0.02–0.03 | 0.5–1.0s |

At **500 daily sessions** (moderate scale), the vision model cost adds roughly **$75–100/month** with GPT-4o, or **$5–10/month** with Gemini Flash. These estimates assume prompt caching (OpenAI's 50% cached input discount) and change-detection frame filtering that skips duplicate screens. Voice pipeline costs (STT + TTS + voice-only LLM) remain unchanged from the current baseline.

---

## Ticket breakdown: 8 implementation tickets

### Dependency graph

```
SCREEN-1 (Extension Setup) ─────┐
                                 ├──► SCREEN-3 (Agent Vision) ──► SCREEN-5 (Workflow Integration)
SCREEN-2 (iOS UI Controls) ─────┘          │                              │
                                           ▼                              ▼
SCREEN-6 (Token/Room Config) ◄──── SCREEN-4 (Agent Handoff) ──► SCREEN-7 (UX Verbal Flows)
                                                                          │
                                                                          ▼
                                                                  SCREEN-8 (E2E + Error Recovery)

Parallel tracks:
  Track A (iOS):     SCREEN-1 → SCREEN-2 ──────────────────────► SCREEN-8
  Track B (Agent):   SCREEN-3 → SCREEN-4 → SCREEN-5 → SCREEN-7 → SCREEN-8
  Track C (API):     SCREEN-6 (independent, can start anytime)
```

**SCREEN-1 and SCREEN-2** can run in parallel with **SCREEN-3 and SCREEN-6**. The critical path runs through the agent track (SCREEN-3 → 4 → 5 → 7 → 8).

---

### SCREEN-1: iOS Broadcast Upload Extension target setup

| Field | Value |
|---|---|
| **Workstream** | sunny-ios |
| **Size** | S (4–6 hours) |
| **Dependencies** | None |

**Acceptance criteria:**
- A new Broadcast Upload Extension target exists in the Xcode project named `SunnyBroadcast`
- The extension uses `LKSampleHandler` from the LiveKit Swift SDK
- App Groups are configured on both the main app and extension targets with identifier `group.<main-app-bundle-id>`
- Extension bundle identifier follows `<main-app-bundle-id>.broadcast` convention
- The extension compiles and can be selected from the system broadcast picker
- H.264 encoding is used (not VP8) to stay within the 50MB memory limit

**Technical approach:**

1. **Create the extension target** in Xcode: File → New → Target → Broadcast Upload Extension. Name: `SunnyBroadcast`. Uncheck "Include UI Extension." Set bundle ID to `<existing-app-bundle-id>.broadcast`.

2. **Replace the generated `SampleHandler.swift`** with:
```swift
import LiveKit

#if os(iOS)
@available(macCatalyst 13.1, *)
class SampleHandler: LKSampleHandler {
    override var enableLogging: Bool { true }
}
#endif
```

3. **Configure App Groups** on both targets: Signing & Capabilities → Add "App Groups" → add `group.<main-app-bundle-id>` to both the main app target and the `SunnyBroadcast` extension target.

4. **Update the extension's `Info.plist`** to include:
```xml
<key>NSExtension</key>
<dict>
    <key>NSExtensionPointIdentifier</key>
    <string>com.apple.broadcast-services-upload</string>
    <key>NSExtensionPrincipalClass</key>
    <string>$(PRODUCT_MODULE_NAME).SampleHandler</string>
    <key>RPBroadcastProcessMode</key>
    <string>RPBroadcastProcessModeSampleBuffer</string>
</dict>
```

5. **Add the LiveKit Swift SDK** as a dependency for the extension target (it's already a dependency of the main app; just add the extension target to the package's target membership).

6. **Ensure Bitcode is disabled** in the extension's Build Settings (`ENABLE_BITCODE = NO`).

**Files to create:**
- `SunnyBroadcast/SampleHandler.swift`
- `SunnyBroadcast/Info.plist`
- `SunnyBroadcast/SunnyBroadcast.entitlements`

**Files to modify:**
- Main app `.entitlements` file (add App Group)
- `*.xcodeproj` or `Package.swift` (add extension target, add LiveKit dependency to extension)

---

### SCREEN-2: iOS screen share UI controls and state management

| Field | Value |
|---|---|
| **Workstream** | sunny-ios |
| **Size** | M (8–12 hours) |
| **Dependencies** | SCREEN-1 |

**Acceptance criteria:**
- A "Share Screen" button (using `RPSystemBroadcastPickerView`) is accessible from the conversation view
- The button has `preferredExtension` set to auto-select the `SunnyBroadcast` extension
- The microphone toggle is hidden on the picker (`showsMicrophoneButton = false`)
- Screen share state is tracked reactively (SwiftUI `@Published` or `@Observable`)
- The app correctly detects when broadcast starts, stops, or crashes via Darwin notification listener for `iOS_BroadcastStopped`
- The screen share track is published alongside the existing audio track in the LiveKit room
- A visible "Screen Sharing Active" indicator is shown in the conversation view
- The main app maintains its LiveKit room connection when backgrounded (via active audio session)

**Technical approach:**

1. **Create a `ScreenShareManager`** (or extend the existing LiveKit service) as an `ObservableObject`:
```swift
class ScreenShareManager: ObservableObject {
    @Published var isSharing: Bool = false
    private var darwinObserver: Any?
    
    func startScreenShare(room: Room) async throws {
        try await room.localParticipant.setScreenShare(enabled: true)
        isSharing = true
    }
    
    func stopScreenShare(room: Room) async throws {
        try await room.localParticipant.setScreenShare(enabled: false)
        isSharing = false
    }
    
    func setupBroadcastStopListener(room: Room) {
        // Listen for iOS_BroadcastStopped Darwin notification
        // When received, update isSharing = false and call setScreenShare(enabled: false)
    }
}
```

2. **Wrap `RPSystemBroadcastPickerView`** in a SwiftUI `UIViewRepresentable`:
```swift
struct BroadcastPickerView: UIViewRepresentable {
    let extensionBundleID: String
    
    func makeUIView(context: Context) -> RPSystemBroadcastPickerView {
        let picker = RPSystemBroadcastPickerView(frame: .zero)
        picker.preferredExtension = extensionBundleID
        picker.showsMicrophoneButton = false
        return picker
    }
}
```

3. **Add the picker to the conversation view** — place it prominently but not in a location where seniors will accidentally tap it. Include a large, clearly labeled custom button that triggers the picker's internal button via `sendActions(for: .touchUpInside)`.

4. **Add the "Sharing Active" overlay** — a persistent green banner at the top of the conversation view: "🟢 Sunny can see your screen."

5. **Handle background audio session** — ensure the `AVAudioSession` category is set to `.playAndRecord` with `.allowBluetooth` and `.defaultToSpeaker` options, and that `UIBackgroundModes` includes `audio`. This keeps the LiveKit signaling connection alive when the senior navigates to other apps.

**Files to create:**
- `Sunny/Services/ScreenShareManager.swift`
- `Sunny/Views/Components/BroadcastPickerView.swift`
- `Sunny/Views/Components/ScreenShareStatusBanner.swift`

**Files to modify:**
- `Sunny/Views/ConversationView.swift` (add picker button and status banner)
- `Info.plist` (ensure `UIBackgroundModes` includes `audio`)
- The existing LiveKit service/session manager (integrate `ScreenShareManager`)

---

### SCREEN-3: Agent video track subscription and frame capture

| Field | Value |
|---|---|
| **Workstream** | sunny-agent |
| **Size** | M (8–10 hours) |
| **Dependencies** | None (can start in parallel with iOS work) |

**Acceptance criteria:**
- The Python agent automatically detects and subscribes to video tracks (screen share) from participants
- A background task continuously reads frames from the `rtc.VideoStream`
- Only the latest frame is retained in memory (no frame queue buildup)
- Frames are resized to **1024×1024** (fit aspect) before LLM injection to manage token cost
- A change-detection mechanism (perceptual hash or pixel-diff) skips duplicate frames — only genuinely new screen content is processed
- Frame state is accessible to the agent's `on_user_turn_completed` hook
- Proper cleanup when video track is unpublished or participant disconnects

**Technical approach:**

1. **Create `screen_capture.py`** — a module responsible for video track management:
```python
import asyncio
from livekit import rtc
from livekit.agents.llm import ImageContent
from livekit.agents.utils.images import encode, EncodeOptions, ResizeOptions

class ScreenCapture:
    def __init__(self):
        self._latest_frame: rtc.VideoFrame | None = None
        self._frame_changed: bool = False
        self._video_stream: rtc.VideoStream | None = None
        self._read_task: asyncio.Task | None = None
        self._prev_hash: int | None = None
    
    @property
    def has_active_stream(self) -> bool:
        return self._video_stream is not None
    
    @property 
    def latest_frame(self) -> rtc.VideoFrame | None:
        return self._latest_frame if self._frame_changed else None
    
    def start_capture(self, track: rtc.Track):
        self.stop_capture()
        self._video_stream = rtc.VideoStream(track)
        self._read_task = asyncio.create_task(self._read_frames())
    
    def stop_capture(self):
        if self._video_stream:
            self._video_stream.close()
            self._video_stream = None
        if self._read_task:
            self._read_task.cancel()
            self._read_task = None
        self._latest_frame = None
    
    async def _read_frames(self):
        async for event in self._video_stream:
            frame_hash = self._compute_hash(event.frame)
            if frame_hash != self._prev_hash:
                self._latest_frame = event.frame
                self._frame_changed = True
                self._prev_hash = frame_hash
    
    def get_image_content(self) -> ImageContent | None:
        if self._latest_frame and self._frame_changed:
            self._frame_changed = False
            return ImageContent(
                image=self._latest_frame,
                inference_width=1024,
                inference_height=1024,
                inference_detail="high"
            )
        return None
    
    def _compute_hash(self, frame: rtc.VideoFrame) -> int:
        # Simple perceptual hash: downsample to 8x8, 
        # convert to grayscale, compute average, threshold
        # This catches major screen changes while ignoring minor artifacts
        pass
```

2. **Wire into the agent's room event handlers** in `agent.py`:
```python
@room.on("track_subscribed")
def on_track_subscribed(track, publication, participant):
    if track.kind == rtc.TrackKind.KIND_VIDEO:
        screen_capture.start_capture(track)
        # Trigger handoff to vision agent (SCREEN-4)

@room.on("track_unsubscribed")  
def on_track_unsubscribed(track, publication, participant):
    if track.kind == rtc.TrackKind.KIND_VIDEO:
        screen_capture.stop_capture()
        # Trigger handoff back to voice agent (SCREEN-4)
```

3. **Implement change detection** using a simple perceptual hash. Downsample each frame to 16×16 grayscale, compute a hash, and compare to the previous. Only frames with a Hamming distance > 3 are considered "changed." This reduces vision model calls from ~150 to ~30–40 per 5-minute session.

**Files to create:**
- `agent/screen_capture.py`

**Files to modify:**
- `agent/agent.py` (add room event handlers for video tracks, instantiate ScreenCapture)
- `agent/requirements.txt` (add any image processing deps like `Pillow` if not already present)

---

### SCREEN-4: Vision-enabled agent and handoff logic

| Field | Value |
|---|---|
| **Workstream** | sunny-agent |
| **Size** | L (12–16 hours) |
| **Dependencies** | SCREEN-3 |

**Acceptance criteria:**
- A `SunnyVisionAgent` class exists with GPT-4o as its LLM, sharing STT (Deepgram) and TTS (Cartesia) with the voice-only agent
- `SunnyVisionAgent` implements `on_user_turn_completed` to inject the latest screen frame into every LLM turn
- When a video track is published by the participant, `SunnyAgent` hands off to `SunnyVisionAgent` with full chat context preserved
- When the video track is unpublished, `SunnyVisionAgent` hands off back to `SunnyAgent` with context preserved
- The vision agent's system prompt includes instructions for describing UI elements using spatial terms seniors understand ("the button in the top right," "scroll down to find...")
- The vision agent announces it can see the screen upon handoff
- All existing function tools (medication, workflows, etc.) remain available in both agents

**Technical approach:**

1. **Define `SunnyVisionAgent`** in a new file or extend the existing agent module:
```python
from livekit.agents import Agent, function_tool, get_job_context
from livekit.agents.llm import ChatMessage, ImageContent

VISION_SYSTEM_PROMPT = """You are Sunny, a warm and patient AI companion helping a senior 
navigate their iPhone. You can now SEE their screen in real-time.

GUIDANCE STYLE:
- Use clear spatial language: "top left," "bottom of the screen," "the blue button that says..."
- Reference exact text you see on buttons, labels, and menus
- Give ONE step at a time, then wait for confirmation
- If you see they're on the wrong screen, gently redirect: "I notice you're on [X]. Let's go back to..."
- Describe what you see briefly before giving instructions so they know you're looking

WHEN A STRUCTURED WORKFLOW IS ACTIVE:
- Validate the current screen matches the expected workflow step
- If it matches, give the specific instruction for this step
- If it doesn't match, help them navigate to the correct screen

WHEN NO WORKFLOW IS ACTIVE (third-party apps, unfamiliar screens):
- Describe what you see on the screen
- Use your best judgment to guide them based on common app patterns
- If unsure, ask what they're trying to accomplish
"""

class SunnyVisionAgent(Agent):
    def __init__(self, screen_capture, workflow_engine, chat_ctx=None):
        super().__init__(
            instructions=VISION_SYSTEM_PROMPT,
            llm="openai/gpt-4o",
            chat_ctx=chat_ctx,
        )
        self._screen_capture = screen_capture
        self._workflow_engine = workflow_engine
    
    async def on_user_turn_completed(self, turn_ctx, new_message):
        image_content = self._screen_capture.get_image_content()
        if image_content:
            new_message.content.append(image_content)
            # If workflow is active, also inject step context (SCREEN-5)
            workflow_context = self._workflow_engine.get_current_step_context()
            if workflow_context:
                new_message.content.append(
                    f"\n[WORKFLOW STEP: {workflow_context}. Validate the screen matches this step.]"
                )
    
    # Include all existing function tools via inheritance or explicit registration
    # e.g., medication tools, workflow tools, user fact tools
```

2. **Implement handoff triggers** in the main agent session setup:
```python
async def entrypoint(ctx: JobContext):
    await ctx.connect(auto_subscribe=AutoSubscribe.SUBSCRIBE_ALL)
    
    screen_capture = ScreenCapture()
    workflow_engine = WorkflowEngine(supabase_client)
    
    voice_agent = SunnyAgent(workflow_engine=workflow_engine)
    
    session = AgentSession(
        stt=deepgram.STT(),
        tts=cartesia.TTS(voice="..."),
    )
    
    @ctx.room.on("track_subscribed")
    def on_track_subscribed(track, pub, participant):
        if track.kind == rtc.TrackKind.KIND_VIDEO:
            screen_capture.start_capture(track)
            vision_agent = SunnyVisionAgent(
                screen_capture=screen_capture,
                workflow_engine=workflow_engine,
                chat_ctx=session.chat_ctx,
            )
            session.update_agent(vision_agent)
            asyncio.create_task(
                session.generate_reply(
                    instructions="Acknowledge that you can now see the user's screen. "
                    "Briefly describe what you see to confirm it's working."
                )
            )
    
    @ctx.room.on("track_unsubscribed")
    def on_track_unsubscribed(track, pub, participant):
        if track.kind == rtc.TrackKind.KIND_VIDEO:
            screen_capture.stop_capture()
            voice_agent_restored = SunnyAgent(
                workflow_engine=workflow_engine,
                chat_ctx=session.chat_ctx,
            )
            session.update_agent(voice_agent_restored)
            asyncio.create_task(
                session.generate_reply(
                    instructions="Let the user know screen sharing has stopped. "
                    "Offer to continue helping with voice-only guidance."
                )
            )
    
    await session.start(agent=voice_agent, room=ctx.room)
```

3. **Ensure all function tools are available on both agents.** If the existing `SunnyAgent` defines tools via `@function_tool` decorators, extract shared tools into a mixin class or base class that both `SunnyAgent` and `SunnyVisionAgent` inherit from.

**Files to create:**
- `agent/vision_agent.py` (SunnyVisionAgent class and vision system prompt)

**Files to modify:**
- `agent/agent.py` (add handoff logic in entrypoint, refactor shared tools into base class)
- `agent/prompts/` or inline prompt strings (add vision-specific prompt)

---

### SCREEN-5: Workflow engine vision integration

| Field | Value |
|---|---|
| **Workstream** | sunny-agent |
| **Size** | L (10–14 hours) |
| **Dependencies** | SCREEN-3, SCREEN-4 |

**Acceptance criteria:**
- When screen sharing is active AND a structured workflow is running, the vision model validates the senior is on the correct screen for the current step
- If the screen doesn't match the expected step, the agent provides corrective guidance ("I see you're on the Home screen, but we need to be in Settings. Let's tap the Settings icon.")
- When screen sharing is active but NO workflow matches the user's request, the agent improvises guidance using what it sees on screen
- The workflow engine exposes a `get_current_step_context()` method that returns a text description of what screen/UI state is expected for the current step
- Third-party app navigation (Uber, DoorDash, banking apps) works in freeform vision mode with reasonable accuracy
- The workflow step advancement can be triggered by visual confirmation (agent sees the screen changed to match the next step) rather than relying solely on the senior's verbal confirmation

**Technical approach:**

1. **Extend the workflow engine** with screen validation context. Each workflow JSON step likely has a description/instruction. Add a method that formats the current step as a validation prompt:
```python
class WorkflowEngine:
    # ... existing code ...
    
    def get_current_step_context(self) -> str | None:
        """Return context about the current workflow step for vision validation."""
        if not self.active_workflow or not self.current_step:
            return None
        
        step = self.current_step
        return (
            f"Step {step['step_number']} of '{self.active_workflow['title']}': "
            f"{step['instruction']}. "
            f"Expected screen: {step.get('expected_screen', 'unknown')}. "
            f"The user should see: {step.get('visual_cue', step['instruction'])}."
        )
    
    def get_freeform_context(self) -> str:
        """Return context for when no workflow matches."""
        return (
            "No structured workflow is active. The user needs help with what's on screen. "
            "Analyze the screen content and provide step-by-step guidance based on what you see. "
            "Identify the app, current screen state, and available actions."
        )
```

2. **Inject workflow context alongside frames** in `SunnyVisionAgent.on_user_turn_completed`:
```python
async def on_user_turn_completed(self, turn_ctx, new_message):
    image_content = self._screen_capture.get_image_content()
    if image_content:
        new_message.content.append(image_content)
        
        step_context = self._workflow_engine.get_current_step_context()
        if step_context:
            new_message.content.append(
                f"\n[ACTIVE WORKFLOW — {step_context} — "
                f"Validate the screenshot matches this step. If yes, give the instruction. "
                f"If no, describe what you see and guide the user to the correct screen.]"
            )
        else:
            new_message.content.append(
                f"\n[NO WORKFLOW ACTIVE — Analyze the screen and help the user with "
                f"whatever they're trying to do. Identify the app and available actions.]"
            )
```

3. **Add visual step advancement** — when the vision model confirms the screen matches the *next* step (not just the current one), auto-advance the workflow:
```python
# In the vision agent's response handling or as a function tool:
@function_tool()
async def confirm_step_completed(self, context):
    """Call this when the screen shows the user has completed the current workflow step."""
    self._workflow_engine.advance_step()
    next_step = self._workflow_engine.get_current_step_context()
    if next_step:
        return f"Step completed! Next: {next_step}"
    return "Workflow complete! The task is finished."
```

4. **Test with representative scenarios:**
   - Structured: "Help me turn on Wi-Fi" → workflow matches → vision validates Settings > Wi-Fi screen
   - Freeform: "Help me order food on DoorDash" → no workflow → vision reads DoorDash UI and improvises
   - Mixed: Senior is mid-workflow but accidentally navigates away → vision detects mismatch → corrective guidance

**Files to create:**
- `agent/screen_validator.py` (optional, if validation logic is complex enough to separate)

**Files to modify:**
- `agent/workflow_engine.py` (add `get_current_step_context()`, `get_freeform_context()`, visual step advancement)
- `agent/vision_agent.py` (wire workflow context into `on_user_turn_completed`)

---

### SCREEN-6: Token generation and room configuration updates

| Field | Value |
|---|---|
| **Workstream** | sunny-api |
| **Size** | S (3–4 hours) |
| **Dependencies** | None (can start immediately) |

**Acceptance criteria:**
- The Supabase Edge Function that generates LiveKit tokens includes `canPublishVideo` (or equivalent) permission for the participant
- The agent's token/dispatch configuration includes `auto_subscribe: SUBSCRIBE_ALL` to receive video tracks
- Video track subscription is enabled in the room configuration
- The token generation function accepts an optional `screen_share_enabled` parameter from the iOS client

**Technical approach:**

1. **Update the token generation Edge Function** (likely in `supabase/functions/generate-token/` or similar):
```typescript
// Add video publish grant to the participant token
const token = new AccessToken(apiKey, apiSecret, {
  identity: userId,
  name: userName,
});

token.addGrant({
  room: roomName,
  roomJoin: true,
  canPublish: true,
  canPublishData: true,
  canSubscribe: true,
  // These are the new additions:
  canPublishSources: [
    TrackSource.MICROPHONE,
    TrackSource.SCREEN_SHARE,  // NEW: allow screen share publishing
  ],
});
```

2. **Verify agent-side room connection** uses `auto_subscribe=AutoSubscribe.SUBSCRIBE_ALL` (or at minimum subscribes to video tracks). This should already be set in the agent's entrypoint but verify.

3. **No schema changes needed** in Supabase — screen sharing is a real-time transport feature, not a persisted data feature. However, consider adding a `screen_share_sessions` analytics table later for monitoring usage.

**Files to modify:**
- `supabase/functions/generate-token/index.ts` (or equivalent — add video publish permissions)
- `agent/agent.py` (verify `auto_subscribe` setting in `ctx.connect()`)

---

### SCREEN-7: Senior UX verbal flows and prompt engineering

| Field | Value |
|---|---|
| **Workstream** | sunny-agent |
| **Size** | M (8–10 hours) |
| **Dependencies** | SCREEN-4 |

**Acceptance criteria:**
- Sunny can verbally prompt seniors to start screen sharing when visual guidance would help
- Sunny verbally acknowledges when screen sharing starts ("I can see your screen now — you're on the home screen")
- Sunny verbally handles the transition from "blind" to "sighted" guidance mid-conversation
- Sunny provides clear verbal instructions for the system broadcast picker dialog ("You'll see a box that says 'Start Broadcast' — go ahead and tap that")
- Sunny explains the red status bar indicator reassuringly
- Error recovery scripts are implemented for: broadcast crashes, accidental stop, extension memory kill
- A `suggest_screen_share` function tool lets the voice-only agent recommend screen sharing when appropriate
- Privacy verbal flow exists: "While I can see your screen, I can see everything — if you need to check something private, just stop sharing first"
- **Proactive-first UX**: The vision system prompt tells the model that verbal confirmation is NOT required — the agent watches the screen and auto-advances steps. The user only speaks when stuck.
- **Screen-share greeting**: On track_subscribed, the greeting tells the user they can just follow along and the agent will watch for each step.
- **Proactive monitor**: The monitor instructions no longer ask the user to confirm; the monitor silently advances on match and only speaks to guide when the screen does not match.

**Implementation notes (proactive-first UX):**
- `vision_agent.py` VISION_SYSTEM_PROMPT: PACING rewritten to remove "wait for confirmation"; VISUAL STEP ADVANCEMENT section merged into PACING.
- `agent.py` track_subscribed greeting: tells user they do not need to confirm verbally.
- `agent.py` `_monitor_screen_changes`: instructions changed from "ask user to confirm" to "call confirm_step_completed and move on" on match.

**Technical approach:**

1. **Add a `suggest_screen_share` tool** to `SunnyAgent` (voice-only):
```python
@function_tool()
async def suggest_screen_share(self, context):
    """Suggest screen sharing when the user seems confused or the task would benefit from visual guidance."""
    return (
        "I think it would help if I could see your screen. "
        "Would you like to share your screen with me? "
        "I'll walk you through how to start it — it's just a couple of taps."
    )
```

2. **Define a `guide_screen_share_start` tool** that provides step-by-step verbal guidance:
```python
@function_tool()
async def guide_screen_share_start(self, context):
    """Guide the senior through starting the screen share broadcast."""
    return (
        "Great! Look for the screen sharing button on your screen — it looks like a "
        "little broadcast icon. Tap on it. Then you'll see a box pop up that says "
        "'Start Broadcast.' Go ahead and tap that button. There will be a short countdown — "
        "three, two, one — and then I'll be able to see your screen. "
        "You'll notice the time at the top of your screen turns red. "
        "That's perfectly normal — it just means the sharing is on."
    )
```

3. **Implement transition scripts** as `generate_reply` instructions triggered by track events (these were outlined in SCREEN-4 but the prompt content is designed here):

   - **Screen share started**: "Perfect, I can see your screen now! It looks like you're on [describe what's visible]. Now, let me help you with..."
   - **Screen share stopped unexpectedly**: "It looks like screen sharing stopped. That's okay — would you like to start it again? Or I can keep helping you with just my voice."
   - **Privacy reminder** (triggered on first screen share per session): "Just so you know — while sharing is on, I can see everything on your screen, like if someone was looking over your shoulder. If you need to check something private like bank messages, you can tap the red clock at the top to stop sharing first."

4. **Add trigger logic** for when to suggest screen sharing. In `SunnyAgent`, add to the system prompt:
```
If the user seems confused about what they see on screen, or asks about something 
that would be much easier to help with visually (like navigating an unfamiliar app, 
finding a specific setting, or reading something on screen), use the suggest_screen_share 
tool to offer screen sharing.
```

**Files to create:**
- `agent/prompts/vision_prompts.py` (all vision-related prompt templates and verbal scripts)

**Files to modify:**
- `agent/agent.py` or `agent/voice_agent.py` (add `suggest_screen_share` and `guide_screen_share_start` tools)
- `agent/vision_agent.py` (refine system prompt, add transition scripts)
- Existing system prompt file (add screen sharing suggestion triggers)

---

### SCREEN-8: Error handling, privacy safeguards, and integration testing

| Field | Value |
|---|---|
| **Workstream** | All (sunny-ios, sunny-agent) |
| **Size** | L (12–16 hours) |
| **Dependencies** | SCREEN-1 through SCREEN-7 |

**Acceptance criteria:**
- **Extension crash recovery**: When the broadcast extension is killed (memory limit), the iOS app detects this within 2 seconds via Darwin notification, updates UI state, and notifies the agent
- **Graceful degradation**: If the vision model API call fails, the agent falls back to voice-only guidance for that turn rather than crashing
- **Session timeout**: Screen sharing auto-stops after 15 minutes with a verbal warning at 12 minutes
- **Memory monitoring**: The broadcast extension monitors its memory usage and proactively reduces frame quality if approaching 40MB (of the 50MB limit)
- **Agent-side video track timeout**: If no new frames arrive for 10 seconds, the agent assumes screen sharing ended and triggers handoff back
- **Privacy safeguards implemented**: Auto-timeout, first-session privacy disclosure, no frame storage/logging on the server
- **End-to-end tested**: Full flow works from broadcast start → agent sees screen → gives guidance → broadcast stop, on at least 3 iPhone models
- **Known LiveKit bug workaround**: `isScreenShareEnabled()` state desync is handled via Darwin notification `iOS_BroadcastStopped`

**Technical approach:**

1. **iOS error handling** — Add to `ScreenShareManager`:
```swift
// Memory monitoring in the broadcast extension (if using custom SampleHandler)
// For LKSampleHandler, rely on crash detection from the main app side

func setupErrorRecovery(room: Room) {
    // 1. Darwin notification listener for unexpected broadcast stop
    DarwinNotificationCenter.shared.addObserver(name: "iOS_BroadcastStopped") {
        Task { [weak self] in
            self?.isSharing = false
            try? await room.localParticipant.setScreenShare(enabled: false)
            // Notify the agent via data message
            try? await room.localParticipant.publish(
                data: "screen_share_stopped_unexpectedly".data(using: .utf8)!,
                options: DataPublishOptions(reliable: true)
            )
        }
    }
    
    // 2. Session timeout (15 minutes)
    DispatchQueue.main.asyncAfter(deadline: .now() + 720) { // 12 min warning
        if self.isSharing {
            // Notify agent to give verbal warning
        }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 900) { // 15 min auto-stop
        if self.isSharing {
            Task { try? await self.stopScreenShare(room: room) }
        }
    }
}
```

2. **Agent-side error handling**:
```python
# In SunnyVisionAgent
async def on_user_turn_completed(self, turn_ctx, new_message):
    try:
        image_content = self._screen_capture.get_image_content()
        if image_content:
            new_message.content.append(image_content)
    except Exception as e:
        logger.warning(f"Failed to capture/encode frame: {e}")
        # Continue without the frame — voice-only for this turn
        new_message.content.append(
            "[Screen frame unavailable for this turn. Provide guidance based on conversation context.]"
        )

# Frame timeout detection
async def _monitor_frame_freshness(self):
    while True:
        await asyncio.sleep(10)
        if self._screen_capture.has_active_stream:
            last_frame_age = time.time() - self._screen_capture.last_frame_time
            if last_frame_age > 10:
                logger.info("No frames received for 10s, assuming screen share ended")
                self._screen_capture.stop_capture()
                # Trigger handoff back to voice agent
```

3. **Privacy safeguards**:
   - Server-side: Frames are processed in-memory only, never written to disk or logged. Add explicit `logger.setLevel` exclusions for frame data.
   - Add a config flag `SCREEN_SHARE_MAX_DURATION_SECONDS = 900` (15 min).
   - First-session disclosure: Track in user session data whether the privacy message has been delivered.

4. **Integration test plan**:
   - Test on iPhone 12 (older), iPhone 14 Pro (mid), iPhone 16 (latest) to verify memory behavior
   - Test: Start broadcast → navigate to Settings → agent describes Settings screen → navigate to third-party app → agent reads third-party UI → stop broadcast → agent acknowledges
   - Test: Force-kill the extension (simulate memory crash) → verify iOS app detects within 2s → verify agent transitions to voice-only
   - Test: 15-minute timeout → verify verbal warning at 12 min → verify auto-stop at 15 min

**Files to modify:**
- `Sunny/Services/ScreenShareManager.swift` (error recovery, timeout, Darwin listener)
- `agent/vision_agent.py` (error handling in frame injection, frame timeout monitor)
- `agent/screen_capture.py` (add `last_frame_time` tracking)
- `agent/agent.py` (add data message listener for unexpected stops)

---

## Risk assessment and mitigations

The highest-impact risk is the **50MB broadcast extension memory limit**. If the extension is killed, the senior loses screen sharing without understanding why. Mitigation: use H.264 encoding exclusively (not VP8), cap frame rate at 10–15fps, and downscale to ~720×1280 within the extension. LiveKit's `LKSampleHandler` handles most of this automatically, but iPad-class devices remain risky and should be deprioritized in initial testing.

The second risk is **vision model latency degrading the voice experience**. Adding a 1024×1024 image to each GPT-4o call adds **0.5–1.0 seconds** to response time. For a senior waiting for guidance, this is noticeable but acceptable — screen sharing sessions are inherently more deliberate than quick voice Q&A. Mitigation: use `inference_detail="low"` for initial screen description (85 tokens, fast) and `"high"` only when the senior asks about specific small text or fine details.

Third, **the system broadcast picker dialog is not customizable** and presents unfamiliar UI to seniors. Apple requires this mandatory permission dialog every time screen sharing starts — there is no way to auto-start programmatically. Mitigation: Sunny's verbal coaching script (SCREEN-7) walks seniors through the dialog step-by-step, and setting `preferredExtension` auto-selects the correct extension so seniors don't face a confusing list.

Fourth, **third-party app vision accuracy is variable**. While GPT-4o handles standard iOS UI patterns well (Settings, Messages, Safari), heavily custom-designed apps (games, some banking apps with proprietary UI) may confuse the model. Mitigation: the freeform mode prompt instructs the agent to say "I'm not quite sure what I'm looking at — can you tell me what app this is?" rather than guessing incorrectly. Over time, common third-party app patterns can be added to the prompt as examples.

Finally, **privacy exposure during screen sharing** is both a technical and trust risk. Seniors may inadvertently share banking credentials, private messages, or medical information. Mitigation: verbal privacy disclosure on first use, a prominent "Sharing Active" indicator, 15-minute auto-timeout, and explicit policy that frames are never stored or logged.

---

## Implementation timeline and parallel execution

The total estimated effort is **65–88 hours** (~2–3 weeks for one developer, or ~1.5 weeks with iOS and agent developers working in parallel).

| Week | iOS Track | Agent Track | API Track |
|---|---|---|---|
| **Week 1** | SCREEN-1 (4–6h), SCREEN-2 (8–12h) | SCREEN-3 (8–10h), SCREEN-6 (3–4h) | SCREEN-6 (shared) |
| **Week 2** | Testing, refinement | SCREEN-4 (12–16h), SCREEN-5 (10–14h) | — |
| **Week 3** | SCREEN-8 iOS portion (6h) | SCREEN-7 (8–10h), SCREEN-8 agent portion (6–10h) | — |

The **critical path** is the agent track: SCREEN-3 → SCREEN-4 → SCREEN-5 → SCREEN-7 → SCREEN-8. iOS work (SCREEN-1, SCREEN-2) can proceed fully in parallel with SCREEN-3 and SCREEN-6. End-to-end integration testing (SCREEN-8) requires both tracks complete. The minimum viable demo — screen sharing working with basic vision guidance — is achievable after SCREEN-1 through SCREEN-4 are complete (~Week 2).