import { Icon } from "../icons";
import { Modal } from "./modal";
import { ScrollView, FlatList } from "./scroll-view";
import { TextInput } from "./text-input";
import { WebView } from "./web-view";
import { copyText } from "./clipboard";
import { useToast } from "./toast";
import { useRevealedText } from "@/hooks/use-revealed-text";

export const pluginReactNativeRuntime = {
  Icon,
  Modal,
  ScrollView,
  FlatList,
  TextInput,
  WebView,
  copyText,
  useRevealedText,
  useToast,
};
