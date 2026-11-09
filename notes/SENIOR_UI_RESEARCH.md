# Senior UI research: reducing cognitive load

Nov 6, 2026. Background for the senior home display (iPad prototype now, e-ink later) and the senior phone. Part 1 is the literature and design guidelines, Part 2 is products that apply them, Part 3 turns both into rules for the Sunny display.

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
