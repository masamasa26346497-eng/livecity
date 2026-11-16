# Mission 159 ward audit (read-only)

| ward | N03 | M140 CI log | M80 runner | local | click class |
|---|---|---|---|---|---|
| miyakojima | ok 6.1km2 | ACCEPTED | ok | unverified | - |
| fukushima | ok 4.68km2 | none | ok | unverified | - |
| konohana | ok 19.36km2 | NOT ACCEPTED | failed | unverified | unclassified |
| nishi | ok 5.23km2 | none | none | unverified | - |
| minato | ok 7.89km2 | ACCEPTED | ok | unverified | - |
| taisho | ok 9.45km2 | ACCEPTED | none | unverified | - |
| tennoji | ok 4.86km2 | ACCEPTED | none | unverified | - |
| naniwa | ok 4.4km2 | ACCEPTED | none | unverified | - |
| nishiyodogawa | ok 14.27km2 | ACCEPTED | none | unverified | - |
| higashiyodogawa | ok 13.32km2 | ACCEPTED | none | unverified | - |
| higashinari | ok 4.55km2 | ACCEPTED | none | unverified | - |
| ikuno | ok 8.4km2 | ACCEPTED | none | unverified | - |
| asahi | ok 6.34km2 | ACCEPTED | none | unverified | - |
| joto | ok 8.41km2 | ACCEPTED | none | unverified | - |
| abeno | ok 5.99km2 | ACCEPTED | none | unverified | - |
| sumiyoshi | ok 9.42km2 | ACCEPTED | none | unverified | - |
| higashisumiyoshi | ok 9.78km2 | ACCEPTED | none | unverified | - |
| nishinari | ok 7.39km2 | NOT ACCEPTED | none | unverified | unclassified |
| yodogawa | ok 12.82km2 | none | none | unverified | - |
| tsurumi | ok 8.2km2 | ACCEPTED | none | unverified | - |
| suminoe | ok 20.74km2 | ACCEPTED | none | unverified | - |
| hirano | ok 15.32km2 | ACCEPTED | none | unverified | - |
| kita | ok 10.37km2 | ACCEPTED | none | unverified | - |
| chuo | ok 8.9km2 | ACCEPTED | none | unverified | - |

```json
{
 "wards": 24,
 "n03Ok": 24,
 "n03Issues": [],
 "localChecked": 0,
 "localFlagged": [],
 "localNotChecked": [
  "miyakojima",
  "fukushima",
  "konohana",
  "nishi",
  "minato",
  "taisho",
  "tennoji",
  "naniwa",
  "nishiyodogawa",
  "higashiyodogawa",
  "higashinari",
  "ikuno",
  "asahi",
  "joto",
  "abeno",
  "sumiyoshi",
  "higashisumiyoshi",
  "nishinari",
  "yodogawa",
  "tsurumi",
  "suminoe",
  "hirano",
  "kita",
  "chuo"
 ],
 "crossWardDupPairs": {},
 "clickMismatch": [
  "konohana:unclassified",
  "nishinari:unclassified"
 ],
 "noEvidenceInGit": [
  "nishi",
  "yodogawa"
 ],
 "browserAcceptedByThisTool": 0,
 "note": "This tool never claims browser acceptance. M140 = headless software GL on a CI runner; local/fixture dirs are data checks only. 24/24 is not established."
}
```
