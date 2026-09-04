import Box from "@mui/material/Box";
import { renderMarkdown } from "../utils/markdown";

interface MarkdownContentProps {
  text: string;
  isUser?: boolean;
}

/** Renders markdown-formatted text produced by {@link renderMarkdown}. */
export default function MarkdownContent({ text, isUser }: MarkdownContentProps) {
  return (
    <Box
      dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
      sx={{
        "& p": { m: 0, mb: 1 },
        "& p:last-child": { mb: 0 },
        "& strong": { fontWeight: 600 },
        "& code": {
          fontFamily: "'Consolas', 'Courier New', monospace",
          fontSize: "12.5px",
          px: "5px",
          py: "2px",
          borderRadius: "4px",
          bgcolor: isUser ? "rgba(255,255,255,0.15)" : "background.default",
          border: "1px solid",
          borderColor: isUser ? "rgba(255,255,255,0.2)" : "divider",
        },
        "& pre": {
          m: "8px 0",
          p: "12px",
          borderRadius: 1,
          bgcolor: "#1e293b",
          border: "1px solid",
          borderColor: "divider",
          overflowX: "auto",
          color: "#e2e8f0",
        },
        "& pre code": {
          p: 0,
          border: "none",
          bgcolor: "transparent",
          fontSize: "12.5px",
          lineHeight: 1.5,
          color: "#e2e8f0",
        },
        "& ul, & ol": { m: "6px 0", pl: "20px" },
        "& li": { mb: "4px" },
        "& a": {
          color: isUser ? "inherit" : "secondary.light",
          textDecorationColor: isUser ? "rgba(255,255,255,0.5)" : "rgba(45,90,142,0.3)",
          textUnderlineOffset: "2px",
        },
      }}
    />
  );
}
