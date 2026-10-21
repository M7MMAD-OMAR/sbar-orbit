"""Bound floating original application windows to their requested workspace monitor."""
import math


def window_size(value=None):
    value = {"width": 960, "height": 640} if value is None else value
    if (not isinstance(value, dict) or set(value) != {"width", "height"}
            or type(value["width"]) is not int or type(value["height"]) is not int
            or not 320 <= value["width"] <= 3840 or not 240 <= value["height"] <= 2160):
        raise ValueError("Window size requires integer width 320 to 3840 and height 240 to 2160")
    return dict(value)


def placement(workspace, requested, workspaces, monitors):
    if (not isinstance(workspaces, list) or not isinstance(monitors, list) or len(monitors) > 32
            or len(workspaces) > 4096 or any(not isinstance(item, dict) for item in workspaces + monitors)):
        raise ValueError("Monitor metadata is unavailable")
    selected = [item for item in workspaces if item.get("id") == workspace]
    if len(selected) > 1:
        raise ValueError("Workspace monitor is ambiguous")
    matches = [monitor for monitor in monitors if monitor.get("name") == selected[0].get("monitor")] if selected else [monitor for monitor in monitors if monitor.get("focused") is True]
    if len(matches) != 1:
        raise ValueError("A unique monitor is required for the requested workspace")
    monitor = matches[0]
    values = [monitor.get(key) for key in ("x", "y", "width", "height", "scale")]
    if any(type(value) not in (int, float) or not math.isfinite(value) for value in values):
        raise ValueError("Monitor dimensions are unavailable")
    x, y, width, height, scale = values
    reserved = monitor.get("reserved", [0, 0, 0, 0])
    if (not 0 < scale <= 8 or width <= 0 or height <= 0 or not isinstance(reserved, list)
            or len(reserved) != 4 or any(type(value) is not int or value < 0 for value in reserved)):
        raise ValueError("Monitor work area is unavailable")
    left, top, right, bottom = reserved
    available_width = math.floor(width / scale) - left - right
    available_height = math.floor(height / scale) - top - bottom
    fitted = {"width": min(requested["width"], available_width - 32),
              "height": min(requested["height"], available_height - 32)}
    if fitted["width"] < 320 or fitted["height"] < 240:
        raise ValueError("Monitor work area is too small for the requested application window")
    return {**fitted, "left": x + left, "top": y + top,
            "right": x + left + available_width, "bottom": y + top + available_height}


def measured_window(window, fitted):
    size, at = window.get("size"), window.get("at")
    if (window.get("floating") is not True or not isinstance(size, list) or len(size) != 2
            or not isinstance(at, list) or len(at) != 2
            or any(type(value) not in (int, float) or not math.isfinite(value) for value in size + at)):
        return None
    width, height = size
    x, y = at
    if (abs((x + width / 2) - (fitted["left"] + fitted["right"]) / 2) > 2
            or abs((y + height / 2) - (fitted["top"] + fitted["bottom"]) / 2) > 2
            or abs(width - fitted["width"]) > 2 or abs(height - fitted["height"]) > 2
            or x < fitted["left"] - 2 or y < fitted["top"] - 2
            or x + width > fitted["right"] + 2 or y + height > fitted["bottom"] + 2):
        return None
    return {"floating": True, "width": width, "height": height, "x": x, "y": y}
