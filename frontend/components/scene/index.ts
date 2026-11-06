/**
 * The op-room scene (plan §3, design §3.3): shared by the live op room, the replay and the wall.
 * Drive it with `usePlayer(toBeats(...))` from lib/scene and pass the frame.
 */
export { OpScene, type OpSceneProps, type OpSceneLayout, type SceneCastle } from "./op-scene";
export { Stage, StageBand, LedStrip, LockdownOverlay, BreachTakeover, ledState, stageCaption, type StageProps, type StageLayout } from "./stage";
export { OpConsole, ClassChip, type OpConsoleProps } from "./op-console";
export { GuardSprite, guardArtWidth, voiceTag, type GuardSpriteProps, type GuardIdentity } from "./guard-sprite";
export { VaultDoor, type VaultDoorProps } from "./vault-door";
export { ClassEffect, PacketFlight, effectClock, type EffectClock, type ClassEffectProps } from "./class-effect";
export { MoveStamp, type MoveStampProps } from "./move-stamp";
export { ThreatMeter, type ThreatMeterProps } from "./threat-meter";
export { CoinFountain, money, type CoinFountainProps } from "./coin-fountain";
export { SplitBars, type SplitBarsProps } from "./split-bars";
export { OutcomeHeadline, SceneOutcome, type OutcomeHeadlineProps, type SceneOutcomeProps } from "./end-dock";
export { FrozenBar, type FrozenBarProps } from "./frozen-bar";
export { SoundStrip } from "./sound-strip";
export { useBeatCues, useTickSounds } from "./use-scene-sound";
