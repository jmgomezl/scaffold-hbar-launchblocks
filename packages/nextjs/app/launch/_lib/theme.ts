import * as Blockly from "blockly/core";

/** Workspace themes matched to the app's DaisyUI light and dark palettes. */
const common = {
  fontStyle: { family: "Inter, ui-sans-serif, system-ui, sans-serif", weight: "500", size: 11 },
  startHats: false,
};

export const lightTheme = Blockly.Theme.defineTheme("launchblocks-light", {
  name: "launchblocks-light",
  base: Blockly.Themes.Classic,
  ...common,
  componentStyles: {
    workspaceBackgroundColour: "#f6f7f9",
    toolboxBackgroundColour: "#ffffff",
    toolboxForegroundColour: "#1f2430",
    flyoutBackgroundColour: "#eceff3",
    flyoutForegroundColour: "#1f2430",
    flyoutOpacity: 0.96,
    scrollbarColour: "#b8bec8",
    scrollbarOpacity: 0.6,
    insertionMarkerColour: "#000000",
    insertionMarkerOpacity: 0.25,
    cursorColour: "#8a93a3",
  },
});

export const darkTheme = Blockly.Theme.defineTheme("launchblocks-dark", {
  name: "launchblocks-dark",
  base: Blockly.Themes.Classic,
  ...common,
  componentStyles: {
    workspaceBackgroundColour: "#16181d",
    toolboxBackgroundColour: "#1f2229",
    toolboxForegroundColour: "#e6e8ec",
    flyoutBackgroundColour: "#23272f",
    flyoutForegroundColour: "#e6e8ec",
    flyoutOpacity: 0.96,
    scrollbarColour: "#4a505c",
    scrollbarOpacity: 0.6,
    insertionMarkerColour: "#ffffff",
    insertionMarkerOpacity: 0.25,
    cursorColour: "#8a93a3",
  },
});
