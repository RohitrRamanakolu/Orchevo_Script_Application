import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Chip from "@mui/material/Chip";

const QUICK_PROMPTS = [
  { emoji: "👋", text: "Hello, who are you?" },
  { emoji: "📋", text: "Summarize your capabilities" },
  { emoji: "🚀", text: "Help me get started" },
];

interface WelcomeScreenProps {
  onQuickPrompt: (prompt: string) => void;
}

export default function WelcomeScreen({ onQuickPrompt }: WelcomeScreenProps) {
  return (
    <Stack
      alignItems="center"
      justifyContent="center"
      spacing={2.5}
      sx={{ height: "100%" }}
    >
      <Box
        sx={{
          width: 80,
          height: 80,
          borderRadius: "50%",
          bgcolor: "rgba(26,58,92,0.05)",
          border: "3px solid",
          borderColor: "divider",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 40,
          boxShadow: 2,
        }}
      >
        🏛️
      </Box>

      <Typography sx={{ fontSize: 22, fontWeight: 600, color: "secondary.main", letterSpacing: "-0.01em" }}>
        ସ୍ୱାଗତ · Welcome
      </Typography>

      <Typography sx={{ color: "text.secondary", fontSize: 14, textAlign: "center", maxWidth: 420, lineHeight: 1.65 }}>
        Ask your question below — your query will be processed through the configured workflow and answered in real time.
      </Typography>

      <Stack direction="row" flexWrap="wrap" gap={1} justifyContent="center" sx={{ maxWidth: 520, mt: 0.5 }}>
        {QUICK_PROMPTS.map((qp) => (
          <Chip
            key={qp.text}
            label={`${qp.emoji} ${qp.text}`}
            onClick={() => onQuickPrompt(qp.text)}
            variant="outlined"
            sx={{
              px: 1,
              py: 2.2,
              fontSize: 13,
              borderColor: "divider",
              bgcolor: "background.paper",
              boxShadow: 1,
              "&:hover": {
                bgcolor: "rgba(247,148,29,0.08)",
                borderColor: "primary.main",
                color: "primary.main",
              },
            }}
          />
        ))}
      </Stack>
    </Stack>
  );
}
