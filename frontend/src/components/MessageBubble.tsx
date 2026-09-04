import Avatar from "@mui/material/Avatar";
import Box from "@mui/material/Box";
import { keyframes } from "@mui/material/styles";
import type { ChatMessage } from "../types";
import MarkdownContent from "./MarkdownContent";
import ThinkingDots from "./ThinkingDots";

const blink = keyframes`50% { opacity: 0; }`;
const msgIn = keyframes`
  from { opacity: 0; transform: translateY(10px); }
  to   { opacity: 1; transform: translateY(0); }
`;

interface MessageBubbleProps {
  message: ChatMessage;
}

export default function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === "user";
  const showThinking = !isUser && message.isStreaming && !message.content;

  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: isUser ? "row-reverse" : "row",
        gap: 1.25,
        animation: `${msgIn} 0.3s ease`,
      }}
    >
      <Avatar
        sx={{
          width: 32,
          height: 32,
          fontSize: 14,
          mt: 0.25,
          boxShadow: 1,
          background: isUser
            ? "linear-gradient(135deg, #1a3a5c, #2d5a8e)"
            : "linear-gradient(135deg, #e8721a, #f7941d)",
        }}
      >
        {isUser ? "👤" : "🤖"}
      </Avatar>

      <Box
        sx={{
          px: 2,
          py: 1.5,
          borderRadius: "10px",
          maxWidth: "80%",
          lineHeight: 1.7,
          fontSize: 14,
          ...(isUser
            ? {
                bgcolor: "secondary.main",
                color: "#fff",
                borderTopRightRadius: "3px",
                boxShadow: 1,
              }
            : {
                bgcolor: "background.paper",
                border: "1px solid",
                borderColor: "divider",
                borderTopLeftRadius: "3px",
                boxShadow: 1,
                color: "text.primary",
              }),
        }}
      >
        {showThinking ? (
          <ThinkingDots />
        ) : (
          <>
            <MarkdownContent text={message.content} isUser={isUser} />
            {message.isStreaming && message.content && (
              <Box
                component="span"
                sx={{
                  display: "inline-block",
                  width: "2px",
                  height: "16px",
                  bgcolor: "primary.main",
                  ml: "2px",
                  verticalAlign: "text-bottom",
                  animation: `${blink} 0.8s step-end infinite`,
                }}
              />
            )}
            {message.isCancelled && !message.content && (
              <em>Cancelled.</em>
            )}
          </>
        )}
      </Box>
    </Box>
  );
}
