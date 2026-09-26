# -*- coding: utf-8 -*-
"""[Mission 35W §1] 35V で入れたネイビー地面を取り消し、35V 直前（babae19）の配色へ戻す。

色は一切手で決めない。すべて `git show babae19:<dev html>` から取り出して突き合わせる。

戻すもの（地面まわり）:
    body / :root --lc-bg / MS_BG_NEUTRAL / GroundVisualLayer の tileTint /
    LandSurfaceLayer の陸色 / hemiGround / COL_NAVY + applyPalette /
    ラベルの明暗反転条件（地面が明るく戻るので night だけに戻す）

戻さないもの（35V のラベル改善。§8 で維持と指示されている）:
    建物名ラベルそのもの / BUILDING_LABEL_SHARE / rank / RECT_MARGIN /
    visibleBuildings カウンタ / 主要ビルの白いバブル
"""
import io
import subprocess
import sys

DEV = 'public/osaka_3d_buildings.ward-ux-v1.html'
BASE = 'babae19'          # 35V 直前

pre = subprocess.run(['git', 'show', BASE + ':' + DEV],
                     capture_output=True, check=True).stdout.decode('utf-8')
s = io.open(DEV, encoding='utf-8').read()


def pre_line(needle):
    """35V 直前の行をそのまま取り出す（手で書き写さないため）。"""
    for line in pre.split('\n'):
        if needle in line:
            return line
    raise SystemExit('pre-35V に見つからない: ' + needle)


def swap(old, new, what):
    global s
    if old not in s:
        raise SystemExit('見つからない（既に戻っている？）: ' + what)
    s = s.replace(old, new, 1)
    print('  戻した:', what)


print('[35W §1] 地面を', BASE, 'へ戻す')

# 1. body 背景
swap('html,body{width:100%;height:100%;overflow:hidden;font-family:\'Segoe UI\',sans-serif;background:#0d1524}',
     pre_line('html,body{width:100%'), 'body 背景')

# 2. Mission19 UI block の --lc-bg（body 背景の最終決定はこちら）
a = s.index('  /* [Mission 35V] Mission19 の UI block')
b = s.index('--lc-bg:#0d1524; --lc-panel:rgba(255,255,255,0.94); --lc-panel-solid:#ffffff;')
b += len('--lc-bg:#0d1524; --lc-panel:rgba(255,255,255,0.94); --lc-panel-solid:#ffffff;')
s = s[:a] + pre_line('--lc-bg:') + s[b:]
print('  戻した: --lc-bg')

# 3. CITY_THEME を丸ごと外し、MS_BG_NEUTRAL を元の定数へ
a = s.index('// ══════════════════════════════════════════════════════════════\n// [Mission 35V] CITY_THEME')
b = s.index("const MS_BG_NEUTRAL = cityTheme('bg');")
b += len("const MS_BG_NEUTRAL = cityTheme('bg');")
pa = pre.index('// [Mission17] 都市模型の背景/地表/fog を統一する明るい neutral tone。')
pb = pre.index('\n', pre.index('const MS_BG_NEUTRAL = 0xf6f7f3;'))
s = s[:a] + pre[pa:pb] + s[b:]
print('  戻した: CITY_THEME 削除 + MS_BG_NEUTRAL')

# 4. GroundVisualLayer の tileTint（パーセル感の振れ幅）
a = s.index('    // [Mission 35V] 暗いネイビー地面では 0.05 の振れ幅はまったく見えないので')
b = s.index('    return (1 - spread / 2) + (h % 100) / 100 * spread;')
b += len('    return (1 - spread / 2) + (h % 100) / 100 * spread;')
s = s[:a] + pre_line('return 0.97 +').lstrip('\n') + s[b:]
print('  戻した: tileTint')

# 5. LandSurfaceLayer の陸色
a = s.index("  // [Mission 35V] 陸の色は CITY_THEME が持つ。")
b = s.index("  const LAND_COLOR_DATA = cityTheme('landData');")
b += len("  const LAND_COLOR_DATA = cityTheme('landData');")
s = s[:a] + pre_line('const LAND_COLOR_MODEL =') + '\n' + pre_line('const LAND_COLOR_DATA =') + s[b:]
print('  戻した: 陸色')

# 6. 地面からの照り返し
a = s.index('      // [Mission 35V] hemiGround は「地面からの照り返しの色」。')
b = s.index("      hemiSky: 0xbfd8f0, hemiGround: cityTheme('hemiGround'), hemiIntensity: 1.0,")
b += len("      hemiSky: 0xbfd8f0, hemiGround: cityTheme('hemiGround'), hemiIntensity: 1.0,")
s = s[:a] + pre_line('hemiSky: 0xbfd8f0, hemiGround: 0xe8dcc8') + s[b:]
print('  戻した: hemiGround')

# 7. COL_NAVY を外し、applyPalette を元へ
a = s.index('  // [Mission 35V §3/§6] 暗いネイビー地面の上での配色。')
b = s.index('    Object.assign(COL, base, dark ? COL_NAVY : {});\n  }')
b += len('    Object.assign(COL, base, dark ? COL_NAVY : {});\n  }')
pa = pre.index('  /** profile に合わせて COL の中身を入れ替える（参照は保つ）。 */')
pb = pre.index('\n', pre.index('function applyPalette() { Object.assign(COL, depthEnabled() ? COL_DEPTH : COL_CURRENT); }'))
s = s[:a] + pre[pa:pb] + s[b:]
print('  戻した: COL_NAVY 削除 + applyPalette')

# 8. ラベルの明暗反転。地面が明るく戻るので、反転の条件を night だけに戻す。
#    tk / inkOnDark という書き方自体は 35V のまま残す（値は 35V 以前と同じになる）。
swap("""    // [Mission 35V §5] 地面がネイビーになると、昼の「濃いインク + 白ハロー」は地面に沈む。
    //   ハローだけのラベル（町名・区名・河川・公園・小さい建物名）は夜と同じ
    //   「明るい文字 + 暗いハロー」へ寄せる。
    //   一方、白い pill を持つラベル（駅・ランドマーク・主要建物名）は白のままのほうが
    //   ネイビーの上でよく読めるので、昼の見た目を保つ（＝参考イメージの白いバブル）。
    const darkMap = night || ((typeof cityThemeDark === 'function') && cityThemeDark());
    const inkOnDark = darkMap;                 // ハロー型ラベルを反転するか
    const tk = darkMap ? (night ? 'n' : 'v') : 'd';   // texture cache key（テーマ違いを混ぜない）""",
     """    // [Mission 35W §1] 地面を 35V 前の明るい配色へ戻したので、ラベルの明暗を反転させる
    //   条件も「夜かどうか」だけに戻す（35V 以前とまったく同じ見た目になる）。
    //   書き方（darkMap / inkOnDark / tk）は 35V のまま残す。
    const darkMap = night;
    const inkOnDark = darkMap;                 // ハロー型ラベルを反転するか
    const tk = darkMap ? 'n' : 'd';            // texture cache key""",
     'ラベルの明暗反転条件')

io.open(DEV, 'w', encoding='utf-8', newline='').write(s)

# 後始末の確認: 35V のテーマ参照が残っていないこと
left = [ln for ln in s.split('\n')
        if ('cityTheme' in ln or 'CITY_THEME' in ln or 'COL_NAVY' in ln)
        and not ln.lstrip().startswith('//')]
if left:
    print('\n! テーマ参照が残っている:')
    for ln in left:
        print('   ', ln.strip()[:100])
    sys.exit(1)
print('\n[35W §1] 完了。テーマ参照の残りなし。')
