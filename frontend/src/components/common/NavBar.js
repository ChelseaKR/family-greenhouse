import React, { useState } from "react";
import { NavLink as RouterNavLink } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import logo from "../../assets/logo.svg";
import "../../index.css";

import { Collapse,
  Container,
  Navbar,
  NavbarToggler,
  NavbarBrand,
  Nav,
  NavItem,
  NavLink,
  Button,
  UncontrolledDropdown,
  DropdownToggle,
  DropdownMenu,
  DropdownItem,
} from "reactstrap";

import { useAuth0 } from "@auth0/auth0-react";

const NavBar = () => {
  const [isOpen, setIsOpen] = useState(false);
  const {
    user,
    isAuthenticated,
    loginWithRedirect,
    logout,
  } = useAuth0();
  const toggle = () => setIsOpen(!isOpen);

  const logoutWithRedirect = () =>
      logout({
        logoutParams: {
          returnTo: window.location.origin,
        },
      });

  return (
      <div className="nav-container color-nav">
        <Navbar light expand="md">
          <Container className="d-flex justify-content-between">
            <NavbarBrand className="logo" href="/">
              <img
                  src={logo}
                  width="40"
                  height="30"
                  alt=""
              />
              <b>Family Greenhouse</b>
            </NavbarBrand>
            <NavbarToggler onClick={toggle} />
            <Collapse isOpen={isOpen} navbar>
              <Nav className="mr-auto" navbar>
                {isAuthenticated && (
                    <NavItem>
                      <NavLink
                          tag={RouterNavLink}
                          to="/greenhouse/history"
                          exact
                          activeClassName="router-link-exact-active"
                      >
                        History
                      </NavLink>
                    </NavItem>
                )}
              </Nav>
              <Nav navbar>
                {!isAuthenticated ? (
                    <NavItem>
                      <Button
                          id="qsLoginBtn"
                          color="primary"
                          className="btn-margin"
                          onClick={() => loginWithRedirect()}
                      >
                        Log in
                      </Button>
                    </NavItem>
                ) : (
                    <UncontrolledDropdown nav inNavbar>
                      <DropdownToggle nav caret id="profileDropDown">
                        <img
                            src={user.picture}
                            alt="Profile"
                            className="nav-user-profile rounded-circle"
                            width="35"
                        />
                      </DropdownToggle>
                      <DropdownMenu>
                        <DropdownItem header>{user.name}</DropdownItem>
                        <DropdownItem
                            tag={RouterNavLink}
                            to="/greenhouse"
                            className="dropdown-profile"
                            activeClassName="router-link-exact-active"
                        >
                          <FontAwesomeIcon icon="house-chimney" className="mr-3" />My Greenhouse
                        </DropdownItem>
                        <DropdownItem
                            tag={RouterNavLink}
                            to="/profile"
                            className="dropdown-profile"
                            activeClassName="router-link-exact-active"
                        >
                          <FontAwesomeIcon icon="user" className="mr-3" /> Profile
                        </DropdownItem>
                        <DropdownItem
                            id="qsLogoutBtn"
                            onClick={() => logoutWithRedirect()}
                        >
                          <FontAwesomeIcon icon="power-off" className="mr-3" /> Log
                          out
                        </DropdownItem>
                      </DropdownMenu>
                    </UncontrolledDropdown>
                )}
              </Nav>
            </Collapse>
          </Container>
        </Navbar>
      </div>
  );
};

export default NavBar;
