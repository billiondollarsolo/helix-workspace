-- Capture is controlled by Workspace hosts, never by client-supplied room metadata.
local json = require 'util.json';
local http = require 'net.http';
local st = require 'util.stanza';
local util = module:require 'util';
local secret = os.getenv('HELIX_JITSI_WEBHOOK_SECRET');
local endpoint = os.getenv('HELIX_CAPTURE_STATE_URL');
assert(secret and #secret >= 32 and endpoint, 'Helix capture configuration is required');
local rooms = {};
local CONSENT = '2026-10-15';
local function user_context(event)
    if util.is_healthcheck_room(event.room.jid) or util.is_admin(event.occupant.bare_jid) then return; end
    local session = event.origin or prosody.full_sessions[event.occupant:get_primary_jid()];
    return session and session.auth_token and session.jitsi_meet_context_user;
end
local function consented(context)
    local count = 0;
    for _, consent in pairs(context.participants) do
        if consent ~= CONSENT then return false; end
        count = count + 1;
    end
    return count > 0;
end
local function update(context, enabled)
    local room = context.room;
    room.jitsiMetadata = room.jitsiMetadata or {};
    local metadata = room.jitsiMetadata;
    metadata.recording = metadata.recording or {};
    if context.enabled == enabled and metadata.recording.isTranscribingEnabled == enabled then return; end
    context.enabled = enabled;
    metadata.asyncTranscription = enabled;
    metadata.recording.isTranscribingEnabled = enabled;
    metadata.transcription = { urlParams = { orgId = context.orgId, roomId = context.roomId } };
    module:fire_event('room-metadata-changed', {room=room});
end
module:context(os.getenv('XMPP_DOMAIN')):hook('jitsi-metadata-allow-moderation', function(event)
    if event.key == 'recording' or event.key == 'transcription' or event.key == 'asyncTranscription' then return false; end
end, 100);
module:hook('muc-occupant-pre-join', function(event)
    local context = rooms[event.room.jid];
    local user = user_context(event);
    if context and context.enabled and user and user.helixCaptureConsent ~= CONSENT then
        event.origin.send(st.error_reply(event.stanza, 'auth', 'forbidden', 'Accept the current capture notice before joining this transcribed meeting.'));
        return true;
    end
end, -3.7);
module:hook('muc-occupant-joined', function(event)
    local user = user_context(event);
    if not user or type(user.helixOrgId) ~= 'string' or type(user.helixRoomId) ~= 'string' then return; end
    local context = rooms[event.room.jid];
    if not context then
        context = {room=event.room,orgId=user.helixOrgId,roomId=user.helixRoomId,participants={},busy=false};
        rooms[event.room.jid] = context;
    end
    if context.orgId ~= user.helixOrgId or context.roomId ~= user.helixRoomId then return; end
    context.participants[event.occupant.jid] = user.helixCaptureConsent or false;
    if not consented(context) then update(context, false); end
end, -101);
module:hook('muc-occupant-left', function(event)
    local context = rooms[event.room.jid];
    if not context then return; end
    context.participants[event.occupant.jid] = nil;
    if not consented(context) then update(context, false); end
end, -101);
module:hook('muc-room-destroyed', function(event) rooms[event.room.jid] = nil; end);
module:add_timer(2, function()
    for room_jid, context in pairs(rooms) do
        if not context.busy then
            context.busy = true;
            http.request(endpoint, {method='POST',body=json.encode({orgId=context.orgId,roomId=context.roomId}),
                headers={['Content-Type']='application/json',Authorization='Bearer '..secret}}, function(body, code)
                context.busy = false;
                if rooms[room_jid] ~= context then return; end
                local response = code == 200 and json.decode(body);
                update(context, response and response.transcription == true and consented(context) or false);
            end);
        end
    end
    return 2;
end);
