# Experiment

Tried caching the parsed JSON across CLI invocations.
Turns out fs.readFileSync is fast enough at this scale.
