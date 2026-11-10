"""Builds a synthetic WhatsApp (26.43, ko-KR) AX snapshot with the same shape as a real dump.
No real conversation data: structure and string formats only."""
import json
from pathlib import Path

LRM = "‎"


def node(path, role, frame=None, children=(), **attrs):
    a = {"AXRole": role, **{f"AX{k}": v for k, v in attrs.items()}}
    return {"path": path, "role": role, "attrs": a, "frame": frame, "children": list(children)}


def bubble(path, desc, y):
    return node(path, "AXStaticText", [1616, y, 380, 40], Identifier="WAMessageBubbleTableViewCell", Description=desc)


def build():
    P = [0, 0, 0, 0, 1]
    rows = [
        node(P + [0, 1, 0, 0, 0], "AXGroup", [994, 149, 605, 72], children=[
            node(P + [0, 1, 0, 0, 0, 0], "AXStaticText", Description=f"{LRM}친구 및 가족과 그룹 대화를 시작하세요.")]),
        node(P + [0, 1, 0, 0, 1], "AXGroup", Identifier="ChatListView_chipButtonsCell"),
        node(P + [0, 1, 0, 0, 2], "AXButton", [994, 274, 605, 69], Description="김민수",
             Value=f"{LRM}메시지, 내일 예약 가능할까요?, 년 11월 9일 오후 3:05, {LRM}김민수님께 받았습니다",
             Help=f"{LRM}대화를 열려면 두 번 탭하세요"),
        node(P + [0, 1, 0, 0, 3], "AXGenericElement", [994, 343, 605, 69], Description="+ 1,5 5 5,1 2 3,4 5 6 7",
             Value=f"{LRM}내 메시지, Yes, 3pm works, 년 11월 9일 오전 11:40, {LRM}+ 1,5 5 5,1 2 3,4 5 6 7님께 보냈습니다., {LRM}읽음",
             Help=f"{LRM}대화를 열려면 두 번 탭하세요", Selected=True),
        node(P + [0, 1, 0, 0, 4], "AXStaticText", [994, 343, 605, 69], Description="+ 1,5 5 5,1 2 3,4 5 6 7",
             Value=f"{LRM}내 메시지, Yes, 3pm works, 년 11월 9일 오전 11:40, {LRM}+ 1,5 5 5,1 2 3,4 5 6 7님께 보냈습니다., {LRM}읽음",
             Help=f"{LRM}대화를 열려면 두 번 탭하세요", Selected=True),
    ]
    chat_list = node(P + [0, 1, 0, 0], "AXGroup", [994, 39, 605, 800], rows, Identifier="ChatListView_TableView",
                     Description=f"{LRM}채팅 리스트")
    msgs = [
        bubble(P + [2, 1, 0, 2, 0], f"{LRM}메시지, Hi, how much is botox?\nAnd do you have parking?, 년 11월 8일 오후 11:58, {LRM}+ 1,5 5 5,1 2 3,4 5 6 7님께 받았습니다", 33),
        node(P + [2, 1, 0, 2, 1], "AXHeading", [1600, 80, 594, 34]),
        bubble(P + [2, 1, 0, 2, 2], f"{LRM}내 메시지, 네, 년 11월 9일 오전 9:01, {LRM}+ 1,5 5 5,1 2 3,4 5 6 7님께 보냈습니다., {LRM}읽음", 120),
        bubble(P + [2, 1, 0, 2, 3], f"{LRM}내 메시지, 네, 년 11월 9일 오전 9:01, {LRM}+ 1,5 5 5,1 2 3,4 5 6 7님께 보냈습니다., {LRM}전송됨", 160),
        bubble(P + [2, 1, 0, 2, 4], f"{LRM}메시지, Price, list, please, 년 11월 9일 오전 11:39, {LRM}+ 1,5 5 5,1 2 3,4 5 6 7님께 받았습니다", 200),
        bubble(P + [2, 1, 0, 2, 5], f"{LRM}내 메시지, Yes, 3pm works, 년 11월 9일 오전 11:40, {LRM}+ 1,5 5 5,1 2 3,4 5 6 7님께 보냈습니다., {LRM}읽음", 240),
        bubble(P + [2, 1, 0, 2, 6], f"{LRM}이 비즈니스는 이제 Meta의 안전한 서비스를 이용하여 대화를 관리합니다.", 280),
        bubble(P + [2, 1, 0, 2, 7], f"{LRM}메시지, 12월 31일 오후 3:00 가능?, 년 12월 30일 오후 12:05, {LRM}+ 1,5 5 5,1 2 3,4 5 6 7님께 받았습니다", 320),
    ]
    header = node(P + [2, 0, 0], "AXButton", [1653, 49, 133, 36], Identifier="NavigationBar_HeaderViewButton",
                  Description="‪+1 (555) 123‑4567‬")
    table = node(P + [2, 1, 0, 2], "AXGroup", [1600, 39, 594, 800], msgs, Identifier="ChatMessagesTableView")
    right = node(P + [2], "AXGroup", [1600, 39, 594, 800], [
        node(P + [2, 0], "AXGroup", Identifier="WDSNavigationBar", children=[header]),
        node(P + [2, 1], "AXGroup", children=[node(P + [2, 1, 0], "AXGroup", children=[
            node(P + [2, 1, 0, 0], "AXButton"), node(P + [2, 1, 0, 1], "AXButton"), table])]),
    ])
    left = node(P + [0], "AXGroup", children=[node(P + [0, 0], "AXGroup", Identifier="WDSNavigationBar"),
                                               node(P + [0, 1], "AXGroup", children=[node(P + [0, 1, 0], "AXGroup", children=[chat_list])])])
    split = node(P, "AXGroup", children=[left, node(P + [1], "AXSplitter"), right])
    window = node([0], "AXWindow", [994, 39, 1200, 800], [node([0, 0], "AXGroup", children=[node([0, 0, 0], "AXGroup", children=[
        node([0, 0, 0, 0], "AXGroup"), split])])], Subrole="AXStandardWindow", Identifier="SceneWindow")
    return node([], "AXApplication", None, [window], Title="WhatsApp")


def fix_paths(n, path=()):
    """Paths must equal tree positions (the backend resolves them by child index)."""
    n["path"] = list(path)
    for i, c in enumerate(n["children"]):
        fix_paths(c, (*path, i))
    return n


if __name__ == "__main__":
    tree = fix_paths(build())
    Path(__file__).with_name("whatsapp_ko.json").write_text(json.dumps(tree, ensure_ascii=False, indent=1))
