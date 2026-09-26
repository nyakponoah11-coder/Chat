'use client';
import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';

// Simple public STUN server. For reliable calls across all networks in
// production, add a TURN server (e.g. from Twilio, Xirsys, or metered.ca)
// to the iceServers list below.
const ICE_SERVERS = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

export default function CallPanel({ channelId, me, video, onClose }) {
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const pcRef = useRef(null);
  const channelRef = useRef(null);
  const [muted, setMuted] = useState(false);
  const [status, setStatus] = useState('Connecting...');

  useEffect(() => {
    let localStream;
    const callId = `call-${channelId}`;

    async function start() {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: video,
        audio: true,
      });
      if (localVideoRef.current) localVideoRef.current.srcObject = localStream;

      const pc = new RTCPeerConnection(ICE_SERVERS);
      pcRef.current = pc;
      localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

      pc.ontrack = (event) => {
        if (remoteVideoRef.current) remoteVideoRef.current.srcObject = event.streams[0];
        setStatus('Connected');
      };

      const channel = supabase.channel(callId, {
        config: { broadcast: { self: false } },
      });
      channelRef.current = channel;

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          channel.send({
            type: 'broadcast',
            event: 'ice-candidate',
            payload: { candidate: event.candidate, from: me.id },
          });
        }
      };

      channel
        .on('broadcast', { event: 'offer' }, async ({ payload }) => {
          if (payload.from === me.id) return;
          await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          channel.send({ type: 'broadcast', event: 'answer', payload: { sdp: answer, from: me.id } });
        })
        .on('broadcast', { event: 'answer' }, async ({ payload }) => {
          if (payload.from === me.id) return;
          if (!pc.currentRemoteDescription) {
            await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
          }
        })
        .on('broadcast', { event: 'ice-candidate' }, async ({ payload }) => {
          if (payload.from === me.id) return;
          try {
            await pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
          } catch (e) {}
        })
        .subscribe(async (subStatus) => {
          if (subStatus === 'SUBSCRIBED') {
            // Whoever joins first offers; simplistic approach: always create an
            // offer, the other side ignores if it already has a remote description.
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            channel.send({ type: 'broadcast', event: 'offer', payload: { sdp: offer, from: me.id } });
          }
        });
    }

    start();

    return () => {
      pcRef.current?.close();
      channelRef.current && supabase.removeChannel(channelRef.current);
      localStream?.getTracks().forEach((t) => t.stop());
    };
  }, [channelId, me.id, video]);

  function toggleMute() {
    const pc = pcRef.current;
    if (!pc) return;
    pc.getSenders().forEach((s) => {
      if (s.track && s.track.kind === 'audio') s.track.enabled = muted;
    });
    setMuted(!muted);
  }

  return (
    <div className="call-screen">
      <p>{status}</p>
      <video id="remoteVideo" ref={remoteVideoRef} autoPlay playsInline />
      <video id="localVideo" ref={localVideoRef} autoPlay playsInline muted />
      <div className="call-controls">
        <button className="mute" onClick={toggleMute}>{muted ? '🔇' : '🎤'}</button>
        <button className="end" onClick={onClose}>📞</button>
      </div>
    </div>
  );
}
