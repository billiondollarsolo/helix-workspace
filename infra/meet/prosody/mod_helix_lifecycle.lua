-- Only JWT identities verified by Prosody may identify Workspace rooms or people.
local json = require "util.json";
local hashes = require "util.hashes";
local uuid = require "util.uuid";
local http = require "net.http";
local jid = require "util.jid";
local st = require "util.stanza";
local util = module:require "util";
local endpoint = os.getenv("HELIX_LIFECYCLE_URL");
local secret = os.getenv("HELIX_JITSI_WEBHOOK_SECRET");
assert(endpoint and endpoint:match("^https?://") and secret and #secret >= 32,
    "Helix lifecycle endpoint and webhook secret are required");
local store = module:open_store("helix_lifecycle", "keyval");
local state, load_error = store:get("state");
assert(not load_error, "Cannot load Helix lifecycle state");
state = state or { pending = {}, rooms = {} };
local queue = state.pending;
local busy, storage_ok = false, true;
local delay, retry_at = 1, 0;
local MAX_PENDING = 4096;

local function persist()
    local ok = store:set("state", state);
    storage_ok = ok and true or false;
    if not storage_ok then module:log("error", "Cannot persist Helix meeting events"); end
    return storage_ok;
end
local function emit(context, kind, participant)
    local payload = {
        event = kind, eventId = uuid.generate(), orgId = context.orgId,
        roomId = context.roomId, roomName = context.roomName,
        occurredAt = os.date("!%Y-%m-%dT%H:%M:%SZ")
    };
    if participant then
        payload.sessionId = participant.sessionId;
        payload.participantId = participant.id;
    end
    table.insert(queue, json.encode(payload));
end
-- A process restart drops its XMPP connections. Preserve departures for the grace timer.
for _, context in pairs(state.rooms) do
    for _, participant in pairs(context.participants) do emit(context, "participant.left", participant); end
end
state.rooms = {};
assert(persist(), "Cannot initialize Helix lifecycle state");
local function drain()
    if busy or #queue == 0 or os.time() < retry_at then return 1; end
    if not persist() then return 5; end
    busy = true;
    local body, timestamp = queue[1], tostring(os.time());
    http.request(endpoint, {
        method = "POST", body = body,
        headers = { ["Content-Type"] = "application/json",
            ["X-Helix-Signature"] = "t=" .. timestamp .. ",v1=" .. hashes.hmac_sha256(secret, timestamp .. "." .. body, true) }
    }, function(_, code)
        busy = false;
        if type(code) == "number" and code >= 200 and code < 300 then
            table.remove(queue, 1);
            persist();
            delay = 1;
        else
            delay = math.min(delay * 2, 60);
            module:log("error", "Helix event delivery failed (HTTP %s); retained for retry", tostring(code));
        end
        retry_at = os.time() + delay;
    end);
    return 1;
end
module:add_timer(1, drain);

local function user_context(event)
    local occupant = event.occupant;
    if util.is_healthcheck_room(event.room.jid) or util.is_admin(occupant.bare_jid) then return; end
    local session = event.origin or prosody.full_sessions[occupant:get_primary_jid()];
    local user = session and session.auth_token and session.jitsi_meet_context_user;
    if not user or type(user.id) ~= "string" or type(user.helixOrgId) ~= "string"
        or type(user.helixRoomId) ~= "string" then return; end
    return user;
end
module:hook("muc-occupant-pre-join", function(event)
    local user = user_context(event);
    if not user then return; end
    local context = state.rooms[event.room.jid];
    local mismatch = context and (context.orgId ~= user.helixOrgId or context.roomId ~= user.helixRoomId);
    local reserved = 0;
    for _, room in pairs(state.rooms) do
        reserved = reserved + 1;
        for _ in pairs(room.participants) do reserved = reserved + 1; end
    end
    if mismatch or not storage_ok or #queue + reserved >= MAX_PENDING - 4 then
        event.origin.send(st.error_reply(event.stanza, "cancel", "service-unavailable",
            "Meeting activity reporting is unavailable. Please try again later."));
        return true;
    end
end, -3.6);
module:hook("muc-occupant-joined", function(event)
    local user = user_context(event);
    if not user then return; end
    local room, occupant = event.room, event.occupant;
    local context = state.rooms[room.jid];
    if not context then
        context = { orgId = user.helixOrgId, roomId = user.helixRoomId,
            roomName = jid.node(room.jid), participants = {} };
        state.rooms[room.jid] = context;
        emit(context, "conference.started");
    end
    if context.orgId ~= user.helixOrgId or context.roomId ~= user.helixRoomId then return; end
    if context.participants[occupant.jid] then return; end
    local participant = { id = user.id, sessionId = uuid.generate() };
    context.participants[occupant.jid] = participant;
    emit(context, "participant.joined", participant);
    persist();
end, -100);
module:hook("muc-occupant-left", function(event)
    local context = state.rooms[event.room.jid];
    local participant = context and context.participants[event.occupant.jid];
    if not participant then return; end
    context.participants[event.occupant.jid] = nil;
    emit(context, "participant.left", participant);
    persist();
end, -100);
module:hook("muc-room-destroyed", function(event)
    local context = state.rooms[event.room.jid];
    if not context then return; end
    emit(context, "conference.ended");
    state.rooms[event.room.jid] = nil;
    persist();
end, 1);
function module.unload() persist(); end
