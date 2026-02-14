import { getOpening } from "@/utils/chess";
import { Text } from "@mantine/core";
import { useContext, useEffect, useState } from "react";
import { useStore } from "zustand";
import { TreeStateContext } from "./TreeStateContext";

function OpeningName() {
  const [openingName, setOpeningName] = useState("");
  const store = useContext(TreeStateContext)!;
  const position = useStore(store, (s) => s.position);

  useEffect(() => {
    // Read root imperatively — we only need position changes to trigger lookup
    const root = store.getState().root;
    getOpening(root, position).then((v) => setOpeningName(v));
  }, [store, position]);

  return (
    <Text style={{ userSelect: "text" }} fz="sm" h="1.5rem">
      {openingName}
    </Text>
  );
}

export default OpeningName;
