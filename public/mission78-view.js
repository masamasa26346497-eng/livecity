// Mission 78: default view policy that keeps roof/ground parallax explainable. No coordinate change.
// A roof at height h seen at pitch p (p=-90 is straight down) is displaced on screen relative to its ground footprint by
//   h * tan(90deg - |p|)   (metres on the ground plane).
// Roads are drawn at ~1.4 m, so a 30 m building looks "shifted" from the road by 30*tan(nadir angle) even when coordinates agree.
(function (root) {
  const REF_HEIGHT_M = 30;       // typical mid-rise used to express parallax
  const MAX_PARALLAX_RATIO = 0.45; // roof displacement should stay under ~45% of its height at default views
  function nadirDeg(pitchDeg) { return 90 - Math.abs(pitchDeg); }
  function parallaxM(heightM, pitchDeg) { return heightM * Math.tan(nadirDeg(pitchDeg) * Math.PI / 180); }
  function parallaxRatio(pitchDeg) { return Math.tan(nadirDeg(pitchDeg) * Math.PI / 180); }
  // Steepest default we use for wide (ward / city) views; below this the horizon fills the screen and labels crowd.
  const DEFAULT_PITCH_DEG = -68;   // ratio ~0.40 (was -45: 1.00, -55: 0.70, -62: 0.53)
  const SELECT_PITCH_DEG = -68;
  function clampPitchDeg(p) { return Math.max(-90, Math.min(-35, p)); }
  root.LC78 = { REF_HEIGHT_M, MAX_PARALLAX_RATIO, DEFAULT_PITCH_DEG, SELECT_PITCH_DEG, nadirDeg, parallaxM, parallaxRatio, clampPitchDeg };
})(typeof window !== 'undefined' ? window : globalThis);
