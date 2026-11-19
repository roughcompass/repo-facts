import "@salt-ds/theme/index.css";
import { Button, SaltProvider, Text } from "@salt-ds/core";

export const Blotter = () => (
  <SaltProvider>
    <Text>Blotter</Text>
    <Button appearance="transparent">Refresh</Button>
  </SaltProvider>
);
