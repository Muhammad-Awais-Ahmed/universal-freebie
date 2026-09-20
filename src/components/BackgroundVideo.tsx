"use client";

import { useState } from "react";
import { Volume2, VolumeX } from "lucide-react";
import styles from "./BackgroundVideo.module.css";

export default function BackgroundVideo() {
  const [isMuted, setIsMuted] = useState(true);

  return (
    <div className={styles.videoContainer}>
      <video
        autoPlay
        loop
        muted={isMuted}
        playsInline
        className={styles.video}
      >
        <source src="/Bg-Video.mp4" type="video/mp4" />
      </video>
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
