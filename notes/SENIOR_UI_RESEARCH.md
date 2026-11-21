# Senior UI research: reducing cognitive load

Nov 6, 2026. Background for the senior home display (iPad prototype now, e-ink later) and the senior phone. Part 1 is the literature and design guidelines, Part 2 is products that apply them, Part 3 turns both into rules for the Sunny display. Part 4 (Nov 17, 2026) covers the senior's iPhone: widgets, the Live Activity and Assistive Access.

A caution on evidence: most dementia-UI work is small, codesigned and rarely tested experimentally. A 2025 scoping review of 87 papers on assistive-technology interfaces for people with dementia found only 14% tested an interface's effectiveness and about half lacked ecological validity. Treat the rules below as strong defaults to test in the pilot, not settled facts.

## Part 1: What the research and guidelines say

### Sources

| Source | Type | What it contributes |
|---|---|---|
| [Lipson-Smith et al. 2025, Designing UIs of assistive technology for people living with dementia](https://onlinelibrary.wiley.com/doi/full/10.1155/hbe2/3850397) | Systematic scoping review, 87 papers | Tailor to the person, offer several modalities (touch, voice, physical button), apply universal design; training doesn't help devices meant for fully independent use |
| [Tapping into the Future: touchscreens for people with dementia, 2025](https://www.tandfonline.com/doi/full/10.1080/10447318.2025.2587243) ([open access](https://www.open-access.bcu.ac.uk/16826/)) | Scoping review, 18 studies | Eight touchscreen recommendations; simplicity first; prominent, easily told-apart action buttons offset tunnel vision; personalisation |
| [Interface design for products for users with advanced age and cognitive impairment (PMC8872458)](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8872458/) | Focus groups with MCI and mild dementia | Match the person's prior experience (familiar objects and words beat new metaphors) |
| [Design guidelines of mobile apps for older adults: systematic review](https://www.researchgate.net/publication/374085207_Design_Guidelines_of_Mobile_Apps_for_Older_Adults_Systematic_Review_and_Thematic_Analysis) | Systematic review | 2 golden rules plus 25 guidelines grouped as navigation, visual design, cognitive load |
| [Accessible web design for older adults (ACM 2025)](https://dl.acm.org/doi/full/10.1145/3763243) | Review | WCAG under-covers working memory, memorising and slower reasoning; guidelines should target those |
| [Design principles for technology self-efficacy in older Australians with MCI (2026)](https://arxiv.org/pdf/2609.00480) | Qualitative study | Confidence matters as much as ability; designs should make success visible |
| [Fisk, Rogers, Charness, Czaja, Sharit, Designing for Older Adults (CREATE)](https://experts.illinois.edu/en/publications/designing-for-older-adults-principles-and-creative-human-factors--3/) | Human-factors textbook | Minimise working-memory demand; support perception (contrast, size, glare); [CHI 2011 follow-up](https://www.cs.ubc.ca/wiki/core/pub/Imager/InteractionDesignReadingGroupPresenterQueue/chi2011LeungEtAlv20100920.pdf) found cutting working-memory load helped most |
| NN/g, UX Design for Seniors, 3rd ed. (123 participants, 6 countries), summarised [here](https://child.chi.sg/files/pdffiles/chi_website_guidelines.pdf) | Usability research | Seniors are slower and more likely to give up after an error than to try another path; keep steps consistent; drastic change hurts seniors most |
| [W3C COGA, Making Content Usable for People with Cognitive and Learning Disabilities](https://w3c.github.io/wai-coga/coga-draft/guide/overview) | W3C note, WCAG supplement | Objectives: help users understand what things are and how to use them, find what they need, use clear content, avoid mistakes, help focus, not rely on memory |
| [Microsoft Inclusive Design for Cognition guidebook](https://inclusive.microsoft.design/articles/inclusive-design-for-cognition-guidebook) | Industry guide | Find the task's cognitive load and remove the mismatch; reduce memory and decisions; use color and patterns consistently |
| [Alzheimer's Society Dementia Digital Design Guidelines](https://www.alzheimers.org.uk/blog/how-design-website-someone-affected-dementia) and [technology charter](https://www.alzheimers.org.uk/technologycharter) | Charity guidance | No abbreviations or acronyms; obvious way home; fewer functions; codesign with people with dementia |
| [DEcOHDE recommendations on designing information for people with dementia (2024)](https://www.scitepress.org/Papers/2024/127020/127020.pdf) | EU project paper | Plain language, one idea per line, predictable layout |
| [Apple Assistive Access, WWDC25 session 238](https://developer.apple.com/videos/play/wwdc2025/238/) | Platform guidance | "Fewer options reduce distractions and lighten the overall cognitive load"; large labelled buttons; row or grid layout; a supporter configures it |
| [Calm Technology (Weiser and Brown; Amber Case)](https://calmtech.com/book) | Design principles | Live in the periphery and come to the centre only when needed; the minimum technology that solves the problem; work even when it fails |
| [Aging colour vision (ESCRS)](https://www.escrs.org/eurotimes/colour-vision), [GerontoVis](https://arxiv.org/pdf/2403.13173) | Vision research | Colour defects in older people are mostly blue-yellow; pastel blue vs purple and yellow vs green are confused; contrast sensitivity falls after 50 and sharply by 80 |
| [Jin, Plocher and Kiff 2007, button size and spacing for older adults](https://www.springerprofessional.de/en/touch-screen-user-interfaces-for-older-adults-button-size-and-sp/2824982); [W3C target-size summary](https://www.w3.org/WAI/GL/mobile-a11y-tf/wiki/Summary_of_Research_on_Touch/Pointer_Target_Size) | Experiments | Older adults need larger, more widely spaced targets (about 11.4 mm minimum, 3-13 mm gaps); a 2024 large-screen study put the optimum at about 40 mm for older users |
| [Remind Me To Remember pilot (PMC7854961)](https://pmc.ncbi.nlm.nih.gov/articles/PMC7854961/) | Pilot study, MCI and dementia | Task completion 93% with timed reminders vs 56% without; clock-checking fell 87% |
| [Errorless-learning reminder app (PMC10525938)](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10525938/); [MindMate single-case study](https://vufind-test.katalog.k.utb.cz/SummonRecord/FETCH-LOGICAL-c394t-8c2eaede7db25bd9a355e472b94021e6bfd31fb402d0c69f1f04f5735dd01a7d3/Details) | Small trials | Multi-step procedures fail; cueing and recognition beat free recall; needs change as dementia progresses, so the presentation must be adjustable |
| [Alzheimer's Society reminder product panel](https://www.alzheimers.org.uk/cy/node/29706) | User panel | People liked a chime before a reminder's message so they knew to listen |

### Takeaways

1. **Don't make them remember; show them.** Working memory and recall decline first in MCI. Show the answer to "what day is it, what now, what next, who's coming" on screen, and favour recognition (a familiar word or photo) over recall. (CREATE, COGA, Microsoft, errorless-learning work)
2. **Fewer things, one at a time.** Every extra element adds load. Show the one thing that needs attention now at full weight, demote everything else, and cut features before adding them. Watch for the opposite failure too: hiding needed things behind menus makes people work harder. (Apple, Toptal and IEEE AgeTech summaries, scoping reviews)
3. **One action, no steps.** Multi-step procedures are where people with dementia stall. Each input should be a single, obvious action with an immediate visible result. No gestures, long-press, swipe, scroll or hidden controls. (Errorless learning, Jitterbug yes/no menu, Komp single knob)
4. **Never change the layout.** Seniors are hurt most by change. Every element keeps its place and its words every day; only the content moves. Same words for scheduled prompts. (NN/g, COGA, SPEC guardrails)
5. **Plain words, no abbreviations.** "Saturday morning" not "Sat 9:41 AM"; "Morning pills" not "Med 1"; spell months out. Use full sentences when speaking, short noun phrases when showing. (Alzheimer's Society, DEcOHDE, dementia clock practice)
6. **Big, high-contrast, not colour-coded.** Large type with real weight, near-black on a light ground, no thin or light-grey text. Never rely on colour alone (especially blue vs purple or yellow vs green); pair state with shape, a word or a check mark. (Vision research, WCAG)
7. **Large, well-spaced targets.** If anything is touchable, make it at least about 15-20 mm (the display is wall-distance, so bigger) with generous gaps. Physical buttons beat touch for this group. (Jin et al., GrandPad, Komp)
8. **Calm by default, loud only when needed.** The screen sits in the periphery and earns attention only when a task comes due, with a pre-chime then a message, and returns to calm after. No animation, badges or counters. (Calm technology, Alzheimer's Society panel)
9. **Make success visible and build confidence.** Show what's done with a clear check, praise without fuss, never show failure in red or say "missed" to the senior. (MCI self-efficacy study, SPEC "never say you already asked")
10. **Familiar beats novel.** Look like a calendar, a clock, a note on the fridge, not like an app. (PMC8872458, Komp's radio-like design)
11. **Several ways in.** Glance, button, voice. Each must work alone. (Lipson-Smith review)
12. **Someone else configures it.** No settings on the senior's device; a trusted supporter sets it up. (Apple Assistive Access, SPEC)

## Part 2: Products that apply these well

| Product | What it does well | Pattern to borrow |
|---|---|---|
| [Day clocks: MemRabel, Relish Day Hub, Robin, American Lifetime](https://relish-life.com/blogs/articles/best-calendar-clocks-for-dementia) ([MemRabel 2](https://livingmadeeasy.org.uk/product/memrabel2-dementia-clock)) | Day and part of day in huge words ("Tuesday", "Morning"), month spelled out; up to 20 carer-set reminders with chime, picture and voice | Orientation header as the biggest element; part-of-day wording; pre-chime then message |
| [Apple Assistive Access](https://www.perkins.org/resource/apple-unveils-new-features-for-global-accessibility-awareness-day/) | Few large labelled tiles, row or grid choice, supporter-configured, big Back button | A short list of labelled rows instead of a dense dashboard; words with every icon |
| [Komp (No Isolation)](https://abilitynet.org.uk/news-blogs/komp-one-button-computer-seniors-your-questions-answered) | One knob, no touch, looks like a radio, content pushed by family | Zero-navigation; family puts content in, the senior only sees it; familiar object |
| [GrandPad](https://www.techhive.com/article/599577/grandpad-senior-tablet-review-this-easy-to-use-device-can-help-families-stay-connected.html) | A few big colourful buttons, designed with advisors aged 75-100, family-managed | Codesign with seniors; refine core functions instead of adding features |
| [Jitterbug Smart4 (Lively)](https://www.safewise.com/jitterbug-phone-review) | A text list menu ("Make a Call") instead of an icon grid; older models had a yes/no menu | Verb-first text labels; a binary yes/no interaction |
| [TRMNL e-ink dashboards](https://hometechhacker.com/trmnl-og-e-ink-dashboard-review-a-focused-battery-powered-family-status-board/) | "A status board, not a control panel"; family passes it several times a day without opening anything | Passive glanceable layout that survives monochrome and slow refresh |
| [Skylight Calendar, Hearth Display](https://wetried.it/compare/hearth-display-vs-skylight-calendar-max/) | Family calendar on the wall, edited from a phone app; chore lists with checkboxes | The "fridge calendar" mental model; remote editing |
| [Samsung Easy mode](https://www.techradar.com/how-to-set-up-easy-mode-android-phone) | Bigger text and icons, fewer home screens, longer touch-and-hold delay to stop accidental taps | Forgiving input; one screen |
| [ElliQ](https://fortune.com/2023/09/27/seniors-robots-caregiving-elliq-intuition-robotics/) | Proactive prompts with a screen that shows what it's saying | Show spoken answers on screen (SPEC already plans this); note SPEC rejects ElliQ's persona |
| [Remind Me To Remember](https://pmc.ncbi.nlm.nih.gov/articles/PMC7854961/) | Timed reminders cut clock-checking 87% | The display should answer "is it time yet?" so they stop checking |

## Part 3: Rules for the Sunny home display

These follow from Parts 1 and 2 plus the SPEC (notes/SPEC.md, "E-ink home display").

- **Hierarchy, top to bottom:** where am I in time (day and part of day) > the one thing due now > what's next and who's coming > the rest of today > the going-out strip. The due item should be readable from across a room.
- **No minute clock** (SPEC). Hour-level words ("Saturday morning", "at 2 o'clock") instead.
- **3-6 items** in the Today list. Done items keep their place with a check mark and are greyed, not struck through or removed, so the list never jumps.
- **State without colour:** due = heavier border, bigger type, an arrow or "Now" word; done = check mark and grey; upcoming = plain. Must read in 1-bit black and white (e-ink).
- **The Done and Talk buttons are physical.** The screen should point to them ("Press Done when you've taken them") rather than draw tappable buttons. On the iPad prototype, on-screen buttons may stand in, but must mirror the hardware's shape, label and position.
- **Never show "missed" or red** to the senior. A late task stays due, worded gently.
- **No settings, menus, scroll or navigation** on the screen.
- **Latest family message and recent answer** (nice to have) appear as a quiet card with the sender's name and photo, never as a badge.
- **Offline mark** is small and calm ("Not connected"); nothing else changes.
- **E-ink readiness:** no gradients, shadows, thin hairlines or meaning carried by colour; large flat shapes; layout refreshes only on state change and part-of-day boundaries.
- **Night view:** a reduced screen ("It's nighttime. Next: breakfast pills at 8 o'clock").

## Part 4: The senior's iPhone (widgets, Live Activity, Assistive Access)

Nov 17, 2026. Background for the iOS extension step of the build order. Parts 1 to 3 still apply; this part adds what is specific to the phone and to Apple's platform rules. Design explorations built from it are in the Figma file "Sunny Caregiver App", page "Senior iOS Extension".

The evidence caution from the top of this file is stronger here: no study found tests Home Screen widgets, Lock Screen widgets or Live Activities with older adults or people with MCI. The platform rules below are Apple's and are firm; the senior-specific rules are inferences from general touchscreen and ageing research and need the pilot to confirm them.

### Sources

| Source | Type | What it contributes |
|---|---|---|
| [Apple HIG, Widgets](https://developer.apple.com/design/human-interface-guidelines/widgets) (updated Oct 13, 2026) | Platform guidance | Sizes, margins, rendering modes, interactivity rules, Dynamic Type range |
| [Apple HIG, Live Activities](https://developer.apple.com/design/human-interface-guidelines/live-activities) (updated Oct 13, 2026) | Platform guidance | Presentations and sizes, one-control rule, alerting, duration and dismissal |
| [WWDC26 session 223, Live Activities essentials](https://developer.apple.com/videos/play/wwdc2026/223/) | Platform guidance | iOS 27 shows the compact and minimal island in landscape; quick actions with `LiveActivityIntent` |
| [WWDC25 session 238, Customize your app for Assistive Access](https://developer.apple.com/videos/play/wwdc2025/238/) and [HIG, Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility) | Platform guidance | Assistive Access design rules, the scene API and the two Info.plist keys |
| [Assistive Access User Guide](https://support.apple.com/guide/assistive-access-iphone/welcome/ios) (iOS 27) | Apple support | What the mode shows outside apps: Rows or Grid home, Lock Screen, badges with a sound, no status icons |
| [WWDC25 session 230, Wake up to the AlarmKit API](https://developer.apple.com/videos/play/wwdc2025/230/) and [AlarmKit](https://developer.apple.com/documentation/alarmkit) | Platform guidance | Alarms that break through Silent mode and Focus, with a stop button and one optional custom button |
| [Urbano, Guerreiro and Nicolau 2020, From skeuomorphism to flat design](https://www.tandfonline.com/doi/full/10.1080/0144929X.2020.1814867); [Chen et al. 2020, Applied Ergonomics](https://flatisbad.com/publications/Chen-ApplErgon20.pdf) | Experiments, adults 65 to 77 against 20 to 40 | Flat design was slower or less accurate for older adults at finding what can be pressed; they preferred and trusted physical-looking controls |
| [Piepenbrock et al. 2013, Positive display polarity is advantageous for both younger and older adults](https://www.tandfonline.com/doi/abs/10.1080/00140139.2013.790485); [NN/g, Dark mode](https://www.nngroup.com/articles/dark-mode/) | Experiments and review | Dark text on a light ground reads better at every age; glare sensitivity rises with age; some people with cataracts do better in dark mode |
| [Touch target research summary (W3C)](https://www.w3.org/WAI/GL/mobile-a11y-tf/wiki/Summary_of_Research_on_Touch/Pointer_Target_Size); [Moffatt and McGrenere, slip errors](https://www.cs.ubc.ca/labs/edapt/papers/moffatt2010.pdf) | Experiments | Older adults make about four times the touch errors of younger adults; slipping off the target is nearly half of their errors (the slip result is from pen input) |
| [Discrete choice experiment on medication reminder interfaces, Frontiers in Medicine 2026](https://www.frontiersin.org/journals/medicine/articles/10.3389/fmed.2026.1749507/full) | Stated preferences, adults over 60 on daily medication | Preferred single-tap confirmation, several reminder modalities, adaptive font and layout, the same behaviour across devices |
| [Bruck and Thomas 2008, alarm signals for older adults](https://link.springer.com/doi/10.1007/s10694-007-0017-5) | Experiment, sleeping adults 65 to 85 | Signals with mid-range components (about 500 to 1600 Hz) are heard more reliably than high-pitched ones; age-related hearing loss takes the high frequencies first |
| ['I'd be lost without my smartphone' (2023)](https://pubmed.ncbi.nlm.nih.gov/37139944) | Interviews, 29 people with dementia or MCI and carers | People in this group already rely on their phones and want help learning them; apps made for memory support are rarely used |

### Apple's platform rules, by surface

Sizes are for the 393 x 852 pt iPhone; other models differ by a few points.

**Widgets**

- Sizes: small 158 x 158, medium 338 x 158, large 338 x 354. Lock Screen: rectangular 160 x 72, inline 234 x 26 (above the clock, one tap target), circular 72 x 72.
- Margins are 16 pt, or 11 pt for tight groups. Apple's floor for text is 11 pt. Widgets follow Dynamic Type from Large to AX5, so the layout must hold when the text grows.
- Buttons and toggles are the only interactive elements. A tap anywhere else opens the app. Apple asks for few of them and for targets that cannot be hit by mistake, and warns against "app-like layouts".
- The system recolours widgets. In the Tinted and Clear Home Screen styles it removes colour. Lock Screen widgets are always monochrome. In StandBy the small widget is scaled up with its background removed and, in low light, tinted red. State must therefore be readable without colour, which Part 1 already requires.
- Widgets are not live. The system decides when a timeline reloads, so "due now" has to be written into the timeline ahead of time from the cached day, the same way the offline rule in the spec works. A push can ask for a reload but does not guarantee one.
- The medium widget cannot hold the day's list, Next up and a comfortable Done button at senior sizes. The spec asks for all three; the designs each choose what to keep.

**Live Activity**

- Lock Screen banner: 371 pt wide and 84 to 160 pt tall, with 14 pt margins and its own background colour if wanted. Dynamic Island: compact leading and trailing areas of 52.33 x 36.67 pt each, minimal 36.67 pt, expanded up to 371 x 160 pt, always on black.
- Apple: "Use large, heavier-weight text", and for controls "prefer limiting it to a single element to help people avoid accidentally tapping the wrong control". One Done button is the intended use.
- An alerting update lights the screen and plays the notification sound. Apple also says "don't use push notifications alongside Live Activities for the same updates". The spec has both a time-sensitive notification and a Live Activity at due time, so one of them should be the cue and the other silent.
- Limits: eight hours at most; after it ends it stays on the Lock Screen for up to four hours unless a dismissal time is set (Apple suggests 15 to 30 minutes). Sunny should end it at once on Done and when the window closes.
- The same activity appears without extra work in StandBy, in the Apple Watch Smart Stack, on the CarPlay Dashboard and in the Mac menu bar. CarPlay disables its buttons.
- iOS 27 shows the compact and minimal island in landscape, limited to a 28 pt circle, so the compact views need a narrow fallback.
- On a phone without a Dynamic Island the activity is only the Lock Screen banner. The pilot phones' models matter.

**Assistive Access**

- Apple's design rules for the mode match Part 1: one or two features, "include both an icon and a label" on every control, "avoid hidden gestures or nested UI", "avoid timed interactions", one decision per screen, and a confirmation asked twice for anything hard to undo.
- There are two ways in. `UISupportsFullScreenInAssistiveAccess` is for an app that is already designed for cognitive disabilities: it keeps its normal screen and fills the display. `UISupportsAssistiveAccess` with an `AssistiveAccess` scene (iOS 26) is a separate SwiftUI hierarchy that gets Apple's large control style and the Rows or Grid layout. Either lists the app under Optimized Apps. Without one, the app runs in a reduced frame above a large Back button.
- Sunny's one-screen app is already the kind of screen the first key is meant for, and it is a React Native app, so the full-screen key is the smaller step. The 30-second Undo line is a timed element, which Apple advises against in this mode.
- The user guide describes the Assistive Access Home Screen as rows or a grid of apps and the Lock Screen as wallpaper, date and time, and an unlock control. It does not mention widgets, Live Activities or notification banners. The only notification setting is Show Notification Badges, under which "an icon appears and a sound plays". Status icons are hidden. So in this mode the widget and the Live Activity are probably absent and the due cue is a sound and a badge on Sunny's row; the app itself has to carry everything. This is the check that the spec already lists for a real phone.

**AlarmKit (iOS 26)**

- An AlarmKit alarm "breaks through the silent mode and the current focus", shows the app's title with a stop button and one optional second button that can run an app intent, and also appears in StandBy and on a paired Apple Watch.
- Apple describes alarms as for "things that occur at a fixed, pre-determined time" and says they "are not a replacement for other prominent notifications, like critical alerts or time-sensitive notifications". A medication time fits the first sentence; whether a reminder to take pills is an acceptable use is not stated.
- It needs its own permission prompt and iOS 26, above the spec's iOS 17.2 floor. Not covered by the sources: whether an alarm can be scheduled or cancelled by push while the app is not running, and how many alarms an app may hold.

### Rules for the senior's phone

These add to the takeaways in Part 1 and the display rules in Part 3.

- **One control per surface.** Each widget and the Live Activity has Done and nothing else that can be pressed. No Undo outside the app.
- **Done must look pressable.** A flat tinted label is the weak case for this age group. Give it a filled shape with weight, an edge or a shadow, and a pressed state that differs in shape as well as shade.
- **Sizes above Apple's floors.** Done in the app at least 88 pt tall and nearly full width (the research range of 11 to 20 mm is 72 to 128 pt on an iPhone). Done in a widget or Live Activity at least 48 pt tall and 120 pt wide, with 12 pt clear around it. No text under 15 pt in the app or 13 pt in a widget.
- **Light appearance by default**, on an off-white ground to limit glare. Follow the phone's dark setting only if a household asks for it.
- **The same words and the same place on every surface.** The label, the time and the button read the same on the display, the app, the widget and the Live Activity, and no element moves between states.
- **Sound.** The due cue should have its energy between about 500 and 1600 Hz, with a haptic alongside it, and should not depend on a high-pitched chime.
- **Pictures help recognition** where the family can supply them (the pills, the visitor's face), always with the word beside them.

### Open questions

1. Is the cue at due time the Live Activity's own alert or the time-sensitive notification? Apple advises against both for the same update. Answered Nov 19, 2026: the Live Activity's alert, with the notification kept for reprompts and for phones where no Live Activity starts.
2. Should medications use AlarmKit so the cue is heard in Silent mode and Focus? It raises the floor to iOS 26 for that feature and adds a permission prompt.
3. What does the medium widget keep: the due task with Done, or the day's list? Both do not fit at these sizes.
4. In Assistive Access, does the 30-second Undo stay, given Apple's advice against timed elements?
5. Which iPhone models are in the pilot? A phone without a Dynamic Island shows only the Lock Screen banner, and Assistive Access households may see neither the widget nor the Live Activity.

### Added Nov 18, 2026: Liquid Glass and Apple's kit

The first round of phone designs ignored Liquid Glass and drew the system chrome from memory. The second round was built on Apple's own Figma kit ([iOS 27 and iPadOS 27](https://www.figma.com/community/file/1651309003795292092/ios-and-ipados-27), listed at [Apple design resources](https://developer.apple.com/design/resources/)). These are the facts it rests on.

**Measured in the kit (iPhone 17 Pro, 402 x 874 pt)**

- Status bar 62 pt tall. Dynamic Island 125 x 37 at x 138.5, y 14. Home indicator 144 x 5, 8 pt above the bottom edge.
- Home Screen widgets: small 164.67 square, medium 349.67 x 164.33, corner radius 28 with corner smoothing, an 18 pt padding guide. The medium widget sits at x 26, y 90.
- Lock Screen: the line above the clock is 26 pt tall at y 82, the clock spans y 115 to 202, and the widget row is 72 pt tall at y 214. A rectangular widget is 169 x 72 with 6 pt inner padding. The notification platter is 386 wide, 8 pt from each edge.
- System buttons are capsules; the kit's heights are 50 (large), 34 (medium) and 28 (small).
- Not in the kit or the guidelines for this screen size, so derived: the Lock Screen Live Activity width (386, to match the platter), the expanded island width (380) and the compact island areas (52.33, Apple's figure for the 393 pt screen).
- The kit has no Assistive Access components. That screen can only be approximated.

**Liquid Glass ([HIG, Materials](https://developer.apple.com/design/human-interface-guidelines/materials); WWDC25 sessions [219](https://developer.apple.com/videos/play/wwdc2025/219/), [356](https://developer.apple.com/videos/play/wwdc2025/356/), [278](https://developer.apple.com/videos/play/wwdc2025/278/))**

- Glass is for the control and navigation layer. Apple: "Don't use Liquid Glass in the content layer", "Use Liquid Glass effects sparingly", "always avoid glass on glass". Tint is "only ... to bring emphasis to primary elements and actions".
- Widgets get it whatever the app does. In the Clear and Tinted Home Screen styles the system removes the widget's background, puts glass or a tint in its place, and draws the content in accented mode, where on iOS everything is tinted white and partly transparent shapes keep their opacity. A filled button with a label of the same colour disappears, so Done needs a translucent fill with a solid edge and label for those styles.
- The tint colour in the Tinted style is the user's, and the wallpaper behind Clear is theirs too. Contrast in those two styles cannot be guaranteed by the design.
- Reduce Transparency makes glass "frostier", Increase Contrast makes elements "predominantly black or white" with a border, Reduce Motion removes the elastic effects. User and developer reports say these only partly restore legibility ([MacRumors](https://www.macrumors.com/2025/09/17/ios-26-liquid-glass-critiques/), [Apple Developer Forums](https://developer.apple.com/forums/thread/811219)); no study with older adults was found.
- A Live Activity on the Lock Screen may still set its own background colour; the Dynamic Island is always black.

**What the designs showed**

- A glass control over a plain paper screen is almost invisible. In the second finalist the floating Talk capsule reads as a control only because of an ink outline and a shadow added to it.
- Glass over content that scrolls beneath it smears that content (refraction), and the scroll edge effect Apple applies there is a gradient over the page. Keeping the list clear of the control avoids both, at which point the glass does no work.
- Text set through the Figma plugin cannot use SF Pro; system-drawn lines in the mockups use Inter as a stand-in.
