import { Button } from "@salt-ds/core";
import styled from "styled-components";

export const Primary = styled(Button)<{ tone: string }>`
  color: ${(props) => props.tone};
  padding: var(--salt-spacing-100) var(--salt-spacing-200);
  border-radius: 4px;
`;
