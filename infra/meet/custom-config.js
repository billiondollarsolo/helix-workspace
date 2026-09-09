// Keep Jitsi signaling on the same origin selected by the deployment ingress.
const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
config.bosh = `${window.location.origin}/http-bind`;
config.websocket = `${wsProtocol}//${window.location.host}/xmpp-websocket`;

// Recording can start only through Helix after its server proves every active
// participant has an unexpired consent grant. Keep Jitsi's bypass UI and
// shortcuts unavailable, while retaining its audible notice for every client.
config.toolbarButtons = [
  "microphone",
  "camera",
  "desktop",
  "chat",
  "participants-pane",
  "raisehand",
  "hangup",
  "fullscreen",
  "settings",
  "tileview",
];
config.disableShortcuts = true;
config.disableRecordAudioNotification = false;
// Prosody is authoritative for group-chat permission and A/V moderation.
// A crafted client cannot promote itself because affiliation comes only from
// Helix-signed context.user.moderator claims.
config.enableFeaturesBasedOnToken = true;
config.groupChatRequiresPermission = true;
config.disableReactionsModeration = false;

// Peer-to-peer calls bypass the managed SRTP bridge and TURN policy.
config.p2p.enabled = false;
