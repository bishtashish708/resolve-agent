# Findings

Empirically verified behaviour of the DaVinci Resolve scripting API and the Workflow Integration
Plugin platform.

This platform is undocumented in places, version-dependent throughout, and community knowledge is
frequently wrong — including on points that look settled. These files record what was actually
tested, how, and on which build.

Each file states: what was tested, the method, Resolve version and OS, the result, and a confidence
level. Claims are tagged `[DOC]` (in Blackmagic's shipped documentation), `[COMM]` (community
reverse-engineering), `[OURS]` (our own tested finding), or `[OPEN]` (unverified).

If you find something here is wrong on your build, that's worth an issue.
