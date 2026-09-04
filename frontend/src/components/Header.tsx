import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import RestartAltIcon from "@mui/icons-material/RestartAlt";

interface HeaderProps {
  onNewChat: () => void;
}

export default function Header({ onNewChat }: HeaderProps) {
  return (
    <Box sx={{ flexShrink: 0 }}>
      {/* Saffron top stripe */}
      <Box
        sx={{
          height: 4,
          background: "linear-gradient(90deg, #ff9933, #f7941d, #ff9933)",
        }}
      />

      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          px: 2.5,
          py: 1.5,
          background: "linear-gradient(135deg, #1a3a5c, #0d2137)",
          color: "#fff",
          boxShadow: 2,
          position: "relative",
          "&::after": {
            content: '""',
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            height: "3px",
            background: "linear-gradient(90deg, #ff9933, #ffffff, #138808)",
          },
        }}
      >
        <Stack direction="row" alignItems="center" spacing={1.5}>
          <Box
            sx={{
              width: 40,
              height: 40,
              borderRadius: "50%",
              bgcolor: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 22,
              boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
              flexShrink: 0,
            }}
          >
            🏛️
          </Box>
          <Stack spacing={0}>
            <Typography sx={{ fontSize: 17, fontWeight: 600, letterSpacing: "-0.01em", lineHeight: 1.2 }}>
              Odisha Workflow Assistant
            </Typography>
            <Typography sx={{ fontSize: 11, opacity: 0.75, letterSpacing: "0.02em", display: { xs: "none", sm: "block" } }}>
              Government of Odisha · ଓଡ଼ିଶା ସରକାର
            </Typography>
          </Stack>
        </Stack>

        <IconButton
          onClick={onNewChat}
          title="New Chat"
          sx={{
            width: 34,
            height: 34,
            borderRadius: "6px",
            border: "1px solid rgba(255,255,255,0.2)",
            bgcolor: "rgba(255,255,255,0.1)",
            color: "#fff",
            "&:hover": { bgcolor: "rgba(255,255,255,0.2)", borderColor: "rgba(255,255,255,0.35)" },
          }}
        >
          <RestartAltIcon fontSize="small" />
        </IconButton>
      </Box>
    </Box>
  );
}
