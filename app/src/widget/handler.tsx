// Android widget lifecycle: render on add / periodic update / resize / refresh tap.
import type { WidgetTaskHandlerProps } from "react-native-android-widget";
import { WIDGETS } from "./AgentsWidget";
import type { WidgetName } from "./AgentsWidget";
import { fetchWidgetData } from "./data";

export async function widgetTaskHandler(props: WidgetTaskHandlerProps) {
  const render = WIDGETS[props.widgetInfo.widgetName as WidgetName];
  if (!render) return;
  switch (props.widgetAction) {
    case "WIDGET_ADDED":
    case "WIDGET_UPDATE":
    case "WIDGET_RESIZED":
    case "WIDGET_CLICK": {
      if (props.widgetAction === "WIDGET_CLICK" && props.clickAction !== "REFRESH") return;
      const data = await fetchWidgetData();
      const size = { width: props.widgetInfo.width, height: props.widgetInfo.height };
      props.renderWidget({ light: render(data, false, size), dark: render(data, true, size) });
      break;
    }
    default:
      break;
  }
}
