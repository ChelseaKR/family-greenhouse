import React from "react";
import { BrowserRouter as Router, Route, Routes } from "react-router-dom";
import { Container } from "reactstrap";

import Loading from "./components/common/Loading";
import NavBar from "./components/common/NavBar";
import Footer from "./components/common/Footer";
import Home from "./views/Home";
import Profile from "./views/Profile";
import { useAuth0 } from "@auth0/auth0-react";
import history from "./utils/history";

import "./App.css";

import initFontAwesome from "./utils/initFontAwesome";
import AddPlant from "./components/plants/add-plant.component";
import Plant from "./components/plants/plant.component";
import PlantsList from "./components/plants/plants-list.component";
initFontAwesome();

const App = () => {
  const { isLoading, error } = useAuth0();

  if (error) {
    return <div>Oops... {error.message}</div>;
  }

  if (isLoading) {
    return <Loading />;
  }

  return (
    <Router history={history}>
      <div id="app" className="d-flex flex-column h-100">
        <NavBar />
        <Container className="flex-grow-1 mt-5">
          <Routes>
            <Route path="/" element={<Home/>} />
            <Route path="/profile" element={<Profile/>} />
            <Route path="/plants" element={<PlantsList/>} />
            <Route path="/plants/:id" element={<Plant/>} />
            <Route path="/add" element={<AddPlant/>} />

          </Routes>
        </Container>
        <Footer />
      </div>
    </Router>
  );
};

export default App;