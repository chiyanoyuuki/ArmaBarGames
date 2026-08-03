// Micro en direct (WebRTC) : le telephone de l'equipe au buzzer diffuse son
// micro, le son sort sur la TV. Signalisation relayee par le serveur (socket).
//
// Modele : le TELEPHONE annonce qu'il parle (rtc:start) ; chaque TV cree alors
// une connexion en "recvonly" et envoie une offre ; le telephone repond en
// ajoutant sa piste micro. Fonctionne en LAN (candidats locaux) comme sur
// Internet (STUN). Le micro exige un contexte securise (HTTPS ou localhost).
import { useEffect, useRef } from "react";
import { socket } from "./socket";
import { S2C, C2S } from "@armabar/shared";

const ICE: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

/** true si le navigateur autorise la capture micro (HTTPS + API dispo). */
export function micSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.isSecureContext &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof RTCPeerConnection !== "undefined"
  );
}

type SignalMsg = { from: string; data: any };

/**
 * Cote TELEPHONE : diffuse le micro tant que `enabled` est vrai.
 * Renvoie rien ; le nettoyage (fermeture des flux) est automatique.
 */
export function useMicSender(enabled: boolean) {
  const pcs = useRef<Map<string, RTCPeerConnection>>(new Map());
  const stream = useRef<MediaStream | null>(null);

  useEffect(() => {
    if (!enabled || !micSupported()) return;
    let cancelled = false;

    const onSignal = async ({ from, data }: SignalMsg) => {
      if (!stream.current) return;
      if (data?.type === "offer") {
        let pc = pcs.current.get(from);
        if (!pc) {
          pc = new RTCPeerConnection(ICE);
          pcs.current.set(from, pc);
          for (const track of stream.current.getTracks()) pc.addTrack(track, stream.current);
          pc.onicecandidate = (e) => {
            if (e.candidate) {
              socket.emit(C2S.RtcSignal, { to: from, data: { type: "candidate", candidate: e.candidate } });
            }
          };
        }
        await pc.setRemoteDescription(data.sdp);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit(C2S.RtcSignal, { to: from, data: { type: "answer", sdp: answer } });
      } else if (data?.type === "candidate" && data.candidate) {
        const pc = pcs.current.get(from);
        if (pc) await pc.addIceCandidate(data.candidate).catch(() => {});
      }
    };
    const onStop = ({ from }: { from: string }) => {
      const pc = pcs.current.get(from);
      if (pc) { pc.close(); pcs.current.delete(from); }
    };

    (async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (cancelled) { s.getTracks().forEach((t) => t.stop()); return; }
        stream.current = s;
        socket.on(S2C.RtcSignal, onSignal);
        socket.on(S2C.RtcStop, onStop);
        socket.emit(C2S.RtcStart);
      } catch {
        /* micro refuse ou indisponible */
      }
    })();

    return () => {
      cancelled = true;
      socket.off(S2C.RtcSignal, onSignal);
      socket.off(S2C.RtcStop, onStop);
      socket.emit(C2S.RtcStop);
      for (const pc of pcs.current.values()) pc.close();
      pcs.current.clear();
      stream.current?.getTracks().forEach((t) => t.stop());
      stream.current = null;
    };
  }, [enabled]);
}

/**
 * Cote TV : recoit et joue le micro des telephones qui parlent.
 * A activer une fois le son debloque (geste utilisateur).
 */
export function useMicReceiver(enabled: boolean) {
  const pcs = useRef<Map<string, RTCPeerConnection>>(new Map());

  useEffect(() => {
    if (!enabled) return;

    const audioEl = (id: string) => {
      const key = "rtc-audio-" + id;
      let el = document.getElementById(key) as HTMLAudioElement | null;
      if (!el) {
        el = document.createElement("audio");
        el.id = key;
        el.autoplay = true;
        document.body.appendChild(el);
      }
      return el;
    };
    const dropAudio = (id: string) => document.getElementById("rtc-audio-" + id)?.remove();

    const onStart = async ({ from }: { from: string }) => {
      if (pcs.current.has(from)) return;
      const pc = new RTCPeerConnection(ICE);
      pcs.current.set(from, pc);
      pc.addTransceiver("audio", { direction: "recvonly" });
      pc.onicecandidate = (e) => {
        if (e.candidate) {
          socket.emit(C2S.RtcSignal, { to: from, data: { type: "candidate", candidate: e.candidate } });
        }
      };
      pc.ontrack = (e) => {
        const el = audioEl(from);
        el.srcObject = e.streams[0];
        el.play().catch(() => {});
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit(C2S.RtcSignal, { to: from, data: { type: "offer", sdp: offer } });
    };
    const onSignal = async ({ from, data }: SignalMsg) => {
      const pc = pcs.current.get(from);
      if (!pc) return;
      if (data?.type === "answer") await pc.setRemoteDescription(data.sdp).catch(() => {});
      else if (data?.type === "candidate" && data.candidate) await pc.addIceCandidate(data.candidate).catch(() => {});
    };
    const onStop = ({ from }: { from: string }) => {
      const pc = pcs.current.get(from);
      if (pc) { pc.close(); pcs.current.delete(from); }
      dropAudio(from);
    };

    socket.on(S2C.RtcStart, onStart);
    socket.on(S2C.RtcSignal, onSignal);
    socket.on(S2C.RtcStop, onStop);
    return () => {
      socket.off(S2C.RtcStart, onStart);
      socket.off(S2C.RtcSignal, onSignal);
      socket.off(S2C.RtcStop, onStop);
      for (const [id, pc] of pcs.current) { pc.close(); dropAudio(id); }
      pcs.current.clear();
    };
  }, [enabled]);
}
