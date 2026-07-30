# HRV and Readiness Monitoring

## Overview

Every wearable now reports a readiness score, and riders make training decisions from them daily. The underlying science is real but considerably messier than the app interfaces suggest. This document covers what heart-rate-based monitoring can and cannot tell you, and how to combine it with the measures that actually predict problems.

**The headline:** subjective self-report measures are at least as predictive as objective ones, and often more so. A rider's own answer to "how do you feel?" is not a soft fallback — it is a primary signal.

## The Monitoring Framework

Bourdon et al. (2017) set out the standard conceptual split:

- **External load:** what the athlete did — power, duration, distance, TSS, kilojoules. Objective and precise.
- **Internal load:** what it cost them — heart rate, RPE, HRV, biochemical markers. This is what drives adaptation.

The same 100 TSS session is a different internal load for a fresh rider than for a sick, stressed, or under-fuelled one. **External load is what you prescribe; internal load is what you monitor.** Systems that track only one of the two are missing half the picture.

## Session-RPE — The Highest-Value Low-Tech Tool

Foster's session-RPE method (2001) remains the best cost-to-value monitoring tool available.

**Protocol:** roughly 30 minutes after the session, the athlete rates the whole session's difficulty on a 0-10 scale. Multiply by session duration in minutes.

**Session load (AU) = RPE × duration in minutes**

A 90-minute session rated 6 = 540 AU.

Its validity and reliability have been confirmed across many sports, intensities, and populations. For cyclists with power meters, session-RPE does not replace TSS — it complements it. **The gap between the two is the diagnostic signal:** when a rider's RPE consistently runs high relative to the TSS produced, something is wrong (fatigue, illness, under-fuelling, life stress) before any power number reveals it.

### Derived Measures

- **Weekly load:** the sum of session loads.
- **Monotony:** mean daily load ÷ standard deviation of daily load. Values above roughly 2.0 indicate an insufficiently varied week — a known risk marker.
- **Strain:** weekly load × monotony.

## Heart Rate Variability — What It Actually Tells You

HRV, usually measured as rMSSD, reflects parasympathetic (vagal) modulation of heart rate. The intuitive story is that higher HRV means better recovery and readiness.

**The evidence does not fully support that story in athletes.** Plews et al. (2013) reviewed HRV in elite endurance athletes and found genuinely equivocal outcomes: both increases *and* decreases in HRV have been associated with negative adaptation, and positive adaptation — including improved cardiorespiratory fitness — has been observed alongside atypical *decreases* in HRV. Their conclusion was blunt: practical ways to use HRV to monitor training status in elite athletes were yet to be established.

Buchheit (2014) reached a compatible conclusion in reviewing heart-rate measures generally — the most useful monitoring tools are short (around 5-minute), near-daily recordings of resting and submaximal exercise heart rate, interpreted longitudinally.

### How to Use HRV Properly

If a rider is going to use HRV, these conditions are non-negotiable:

1. **Measure under identical conditions every time** — same time of day (on waking is standard), same posture, same duration, before caffeine, before checking a phone. Inconsistent measurement produces noise, not data.
2. **Use the weekly rolling average, not the daily value.** Day-to-day HRV is extremely variable and single readings are close to meaningless.
3. **Establish an individual baseline over 3-4 weeks** before interpreting anything.
4. **Watch trend and variability together.** A *falling* weekly mean *and* rising day-to-day variation is a more meaningful warning than either alone.
5. **Never override how a rider feels with what the app says.** An athlete who feels great with a red readiness score usually is fine. An athlete who feels terrible with a green score is not fine.

### What HRV Cannot Do

- It cannot distinguish training fatigue from work stress, a poor night's sleep, alcohol, illness, or a hot bedroom.
- It cannot tell you what to do — a suppressed value tells you something is loading the system, not what or how to respond.
- It is not a substitute for asking the athlete.

## Subjective Monitoring — The Most Predictive Signal

Saw et al. (2016) found that subjective measures reflected acute and chronic training loads with greater sensitivity and consistency than objective measures. This finding is inconvenient for wearable manufacturers and central to good coaching.

### A Practical Daily Wellness Check

Five items, each 1-5, taking under a minute:

- Sleep quality
- Fatigue
- Muscle soreness
- Stress
- Mood

Sum for a daily score and track the trend against the rider's own baseline. **A drop of more than about 20% below a rider's typical score, sustained for several days, is a genuine red flag** — treat it as more informative than any wearable metric.

Keep the questionnaire short and consistent. Long, changing questionnaires get abandoned or answered carelessly, and careless data is worse than none.

## Resting and Submaximal Heart Rate

- **Resting HR:** a sustained elevation of **5-10 bpm above baseline** across several mornings suggests fatigue, illness, dehydration, or significant stress. Simple, cheap, and reasonably reliable.
- **Submaximal HR:** heart rate at a fixed, repeatable submaximal power. A rise at the same power suggests fatigue or heat strain; a fall over weeks suggests improving fitness. Requires a standardised warm-up segment to be useful.
- **HR recovery:** the drop in heart rate in the 60 seconds after a standardised effort. Slower recovery can indicate accumulated fatigue.

## Building a Monitoring System That Works

**Minimum viable system** — for most amateur riders:
1. Daily: 1-5 wellness check (or at minimum, sleep and fatigue)
2. Per session: session-RPE
3. Weekly: body mass, resting HR trend
4. Ongoing: CTL, ATL, TSB from power data

That covers the great majority of the value. HRV is optional refinement.

**Add HRV when:** the rider is consistent enough to measure properly, is training enough for the signal to matter, and understands it is one input among several.

### Rules for Interpretation

- **No single metric triggers a decision.** Look for agreement across several.
- **Trends over days, never single points.**
- **Individual baselines, never population norms.** HRV in particular varies enormously between people; comparing riders is meaningless.
- **When objective and subjective disagree, investigate — don't pick a winner.** The disagreement is itself information.
- **A monitoring system nobody sustains is worth nothing.** Five simple items completed daily for a year beats an elaborate protocol abandoned in March.

## Connecting Monitoring to Action

| Pattern | Likely meaning | Action |
|---|---|---|
| Wellness down, HRV down, RPE up at same power | Accumulating fatigue | Reduce load 40-50% for 5-7 days |
| Wellness down, resting HR up, sore throat | Illness onset | Stop intensity; easy or rest until resolved |
| Wellness fine, HRV low, performance fine | Likely measurement noise or non-training stress | Continue; keep watching the trend |
| RPE high relative to TSS for 3+ sessions | Fatigue, under-fuelling, or life stress | Check sleep and energy intake before touching training |
| Everything flat, performance stalled, weight falling | Possible low energy availability | Screen and refer (see nutrition knowledge base) |

## Sources
Bourdon, Cardinale, Murray, Gastin, Kellmann, Varley, Cable. "Monitoring Athlete Training Loads: Consensus Statement." Int J Sports Physiol Perform. 2017;12(S2):S2-161-S2-170.
Foster et al. "A new approach to monitoring exercise training." J Strength Cond Res. 2001;15(1):109-15.
Plews, Laursen, Stanley, Kilding, Buchheit. "Training adaptation and heart rate variability in elite endurance athletes: opening the door to effective monitoring." Sports Med. 2013;43(9):773-81.
Buchheit. "Monitoring training status with HR measures: do all roads lead to Rome?" Front Physiol. 2014;5:73.
Saw, Main, Gastin. "Monitoring the athlete training response: subjective self-reported measures trump commonly used objective measures." Br J Sports Med. 2016;50(5):281-91.
Halson. "Monitoring Training Load to Understand Fatigue in Athletes." Sports Med. 2014;44(S2):S139-47.
