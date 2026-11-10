import ApplicationServices
import Foundation

func attribute(_ e: AXUIElement, _ key: String) -> AnyObject? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(e, key as CFString, &value) == .success ? value : nil
}
func text(_ e: AXUIElement, _ key: String) -> String { attribute(e,key) as? String ?? "" }
func children(_ e: AXUIElement) -> [AXUIElement] { attribute(e,kAXChildrenAttribute) as? [AXUIElement] ?? [] }
let pid = pid_t(CommandLine.arguments[1])!
let app = AXUIElementCreateApplication(pid)
let windows = attribute(app,kAXWindowsAttribute) as? [AXUIElement] ?? []
var menus = windows.flatMap { children($0) }.filter { text($0,kAXRoleAttribute) == kAXMenuRole }
let point = CGEvent(source:nil)!.location
var hovered: AXUIElement?
var hoveredPid: pid_t = 0
if AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(),Float(point.x),Float(point.y),&hovered) == .success,
   var item = hovered,
   AXUIElementGetPid(item, &hoveredPid) == .success,
   hoveredPid == pid {
    for _ in 0..<6 {
        if text(item,kAXRoleAttribute) == kAXMenuRole { menus.insert(item,at:0); break }
        guard let parent = attribute(item,kAXParentAttribute) else { break }
        item = parent as! AXUIElement
    }
}
for menu in menus {
    let items = children(menu)
    let names = items.map { text($0,kAXTitleAttribute) }
    if names.contains("Rename") || names.contains("Edit…") {
        if CommandLine.arguments.count > 2 {
            guard let item=items.first(where:{text($0,kAXTitleAttribute)==CommandLine.arguments[2]}) else { continue }
            guard AXUIElementPerformAction(item,kAXPressAction as CFString) == .success else { exit(2) }
        }
        print(String(data:try! JSONSerialization.data(withJSONObject:names),encoding:.utf8)!)
        exit(0)
    }
}
print("No file/favorite menu. AX menus: \(menus.map { children($0).map { text($0,kAXTitleAttribute) } })")
exit(1)
