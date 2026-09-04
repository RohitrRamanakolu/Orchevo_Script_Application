import { useRef } from "react";
import type { ChangeEvent, KeyboardEvent } from "react";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import IconButton from "@mui/material/IconButton";
import InputBase from "@mui/material/InputBase";
import Typography from "@mui/material/Typography";
import { keyframes } from "@mui/material/styles";
import AttachFileIcon from "@mui/icons-material/AttachFile";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import StopIcon from "@mui/icons-material/Stop";

const pulseStop = keyframes`
  0%, 100% { box-shadow: 0 0 0 0 rgba(198, 40, 40, 0.3); }
  50%      { box-shadow: 0 0 0 5px rgba(198, 40, 40, 0); }
`;

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  isStreaming: boolean;
  attachedFile: File | null;
  onAttachFile: (file: File) => void;
  onRemoveFile: () => void;
}

export default function ChatInput({
  value,
  onChange,
  onSend,
  onStop,
  isStreaming,
  attachedFile,
  onAttachFile,
  onRemoveFile,
}: ChatInputProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (isStreaming) {
        onStop();
      } else {
        onSend();
      }
    }
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onAttachFile(file);
  };

  const handleSendClick = () => {
    if (isStreaming) {
      onStop();
    } else {
      onSend();
    }
  };

  return (
    <Box sx={{ px: 2, pt: 1.5, pb: 2, bgcolor: "background.paper", borderTop: "1px solid", borderColor: "divider", flexShrink: 0 }}>
      {attachedFile && (
        <Chip
          label={attachedFile.name}
          icon={<span>📎</span>}
          onDelete={onRemoveFile}
          size="small"
          sx={{
            mb: 1,
            bgcolor: "rgba(247,148,29,0.08)",
            border: "1px solid rgba(247,148,29,0.25)",
            color: "primary.main",
            "& .MuiChip-deleteIcon": { color: "primary.main" },
          }}
        />
      )}

      <Box
        sx={{
          display: "flex",
          alignItems: "flex-end",
          gap: 1,
          py: 1,
          pl: 2,
          pr: 1,
          borderRadius: "14px",
          bgcolor: "background.paper",
          border: "1.5px solid",
          borderColor: "grey.400",
          boxShadow: 1,
          transition: "all 0.2s ease",
          "&:focus-within": {
            borderColor: "primary.main",
            boxShadow: "0 0 0 3px rgba(247,148,29,0.12)",
          },
        }}
      >
        <InputBase
          multiline
          minRows={1}
          maxRows={6}
          autoFocus
          placeholder="ଆପଣଙ୍କ ପ୍ରଶ୍ନ ଲେଖନ୍ତୁ… Type your question…"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          sx={{ flex: 1, fontSize: 14, lineHeight: 1.5, py: "6px" }}
        />
        <input ref={fileInputRef} type="file" hidden onChange={handleFileChange} />
        <IconButton
          title="Attach file"
          onClick={() => fileInputRef.current?.click()}
          sx={{
            width: 36,
            height: 36,
            borderRadius: "6px",
            color: attachedFile ? "primary.main" : "text.disabled",
            "&:hover": { color: "primary.main", bgcolor: "rgba(247,148,29,0.08)" },
          }}
        >
          <AttachFileIcon fontSize="small" />
        </IconButton>
        <IconButton
          title={isStreaming ? "Stop" : "Send"}
          onClick={handleSendClick}
          sx={{
            width: 36,
            height: 36,
            borderRadius: "6px",
            bgcolor: isStreaming ? "error.main" : "primary.main",
            color: "#fff",
            animation: isStreaming ? `${pulseStop} 1.5s ease-in-out infinite` : "none",
            "&:hover": { bgcolor: isStreaming ? "error.dark" : "primary.light" },
          }}
        >
          {isStreaming ? <StopIcon fontSize="small" /> : <PlayArrowIcon fontSize="small" />}
        </IconButton>
      </Box>

      <Typography sx={{ textAlign: "center", fontSize: 11, color: "text.disabled", mt: 1 }}>
        <Box component="kbd" sx={{ px: "5px", py: "1px", borderRadius: "3px", bgcolor: "background.default", border: "1px solid", borderColor: "divider", fontFamily: "'Consolas', monospace", fontSize: 10 }}>
          Enter
        </Box>{" "}
        to send ·{" "}
        <Box component="kbd" sx={{ px: "5px", py: "1px", borderRadius: "3px", bgcolor: "background.default", border: "1px solid", borderColor: "divider", fontFamily: "'Consolas', monospace", fontSize: 10 }}>
          Shift+Enter
        </Box>{" "}
        for newline
      </Typography>
    </Box>
  );
}
