import { Button, StackLayout } from "@salt-ds/core";
import { Button as MuiButton, TextField } from "@mui/material";
import "./desk.css";

export function Desk({ onTrade }: { onTrade: () => void }) {
  return (
    <StackLayout gap={1}>
      <Button appearance="solid" sentiment="accented" onClick={onTrade}>
        Trade
      </Button>
      <Button appearance="bordered">Cancel</Button>
      <MuiButton variant="outlined" color="secondary">
        Export
      </MuiButton>
      <TextField label="Notional" />
      <button type="reset">Reset</button>
    </StackLayout>
  );
}
