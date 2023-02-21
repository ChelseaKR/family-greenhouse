import { library } from "@fortawesome/fontawesome-svg-core";
import { faLink, faPowerOff, faUser, faPlus } from "@fortawesome/free-solid-svg-icons";

function initFontAwesome() {
  library.add(faPlus);
  library.add(faLink);
  library.add(faUser);
  library.add(faPowerOff);
}

export default initFontAwesome;
