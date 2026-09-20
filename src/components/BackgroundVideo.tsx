"use client";

import { useState } from "react";
import { Volume2, VolumeX } from "lucide-react";
import styles from "./BackgroundVideo.module.css";

const playlist = [
  "/Bg-Video.mp4",
  "/screencracking-steve.mp4"
];

export default function BackgroundVideo() {
  const [isMuted, setIsMuted] = useState(true);
  const [currentVideo, setCurrentVideo] = useState(0);

  const handleVideoEnded = () => {
    setCurrentVideo((prev) => (prev + 1) % playlist.length);
  };

  return (
    <div className={styles.videoContainer}>
      <video
        key={playlist[currentVideo]}
        src={playlist[currentVideo]}
        autoPlay
        muted={isMuted}
        playsInline
        onEnded={handleVideoEnded}
        className={styles.video}
      />
      <div className={styles.overlay} />
      <button 
        className={styles.muteBtn}
        onClick={() => setIsMuted(!isMuted)}
        title={isMuted ? "Unmute Background Video" : "Mute Background Video"}
      >
        {isMuted ? <VolumeX size={16} /> : <Volume2 size={16} />}
      </button>
    </div>
  );
}
