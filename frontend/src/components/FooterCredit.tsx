import Typography from "@mui/material/Typography";

export default function FooterCredit() {
  return (
    <Typography
      sx={{
        textAlign: "center",
        fontSize: 10,
        color: "text.disabled",
        py: "4px",
        pb: 1,
        bgcolor: "background.paper",
        letterSpacing: "0.02em",
      }}
    >
      Powered by Paradigm IT · Government of Odisha
    </Typography>
  );
}
