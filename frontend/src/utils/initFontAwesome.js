import { library } from "@fortawesome/fontawesome-svg-core";
import { faLink, faPowerOff, faUser, faPlus, faHouseChimney } from "@fortawesome/free-solid-svg-icons";

function initFontAwesome() {
  library.add(faPlus);
  library.add(faLink);
  library.add(faUser);
  library.add(faHouseChimney);
  library.add(faPowerOff);
}

export default initFontAwesome;
