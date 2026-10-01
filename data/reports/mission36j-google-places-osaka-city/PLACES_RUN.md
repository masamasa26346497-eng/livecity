# Mission 36J Google Places citywide run

This marker starts the checkpointed high-priority Google Places matching workflow.

Safety policy:
- hard distance ceiling: 120m
- persist VERIFIED linkage only
- never persist photo binaries, photo URLs, media URLs, or photo resource names
- batch checkpoints are committed after each 100 facilities
