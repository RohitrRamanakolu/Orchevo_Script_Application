import { useEffect, useRef, useState } from "react";
import Chip from "@mui/material/Chip";
import PauseIcon from "@mui/icons-material/Pause";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";

interface AudioAttachmentChipProps {
  file: File;
  onRemove: () => void;
}

/** A file chip for an attached audio recording — click it to play/pause. */
export default function AudioAttachmentChip({ file, onRemove }: AudioAttachmentChipProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    // Create the object URL inside the effect (not outside/in a ref) so that
    // React StrictMode's dev-only mount→cleanup→remount cycle revokes only
    // the URL it itself created, rather than revoking the one still in use.
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
    } else {
      void audio.play();
    }
  };

  return (
    <>
      <Chip
        label={file.name}
        icon={isPlaying ? <PauseIcon fontSize="small" /> : <PlayArrowIcon fontSize="small" />}
        onClick={togglePlay}
        onDelete={onRemove}
        size="small"
        sx={{
          mb: 1,
          cursor: "pointer",
          bgcolor: "rgba(247,148,29,0.08)",
          border: "1px solid rgba(247,148,29,0.25)",
          color: "primary.main",
          "& .MuiChip-icon": { color: "primary.main" },
          "& .MuiChip-deleteIcon": { color: "primary.main" },
        }}
      />
      <audio
        ref={audioRef}
        src={url ?? undefined}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => setIsPlaying(false)}
        hidden
      />
    </>
  );
}
