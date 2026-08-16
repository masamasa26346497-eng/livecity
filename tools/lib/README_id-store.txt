tools/lib/id-store.js はこのZIPに含まれていません（意図的）。
同梱の共有libは io-guard.cjs / znegate-core.cjs / tiles-digest.cjs の3つのみで、id-store.js は不要です
（split-building-tiles.js / convert-plateau-buildings.js のみが使用）。
実機の tools/lib/id-store.js を誤って上書きする事故を避けるため、本ZIPには含めていません。
