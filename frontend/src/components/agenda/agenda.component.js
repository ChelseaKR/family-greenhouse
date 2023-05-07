import React, { useState, useEffect, useCallback } from "react";
import AgendaDataService from "../../services/agenda.service";
import { withAuth0 } from "@auth0/auth0-react";
import AgendaItem from "./agenda-item";

const Agenda = ({ auth0 }) => {
    const { user } = auth0;
    const [greenhouse, setGreenhouse] = useState(user.greenhouse);
    const [plants, setPlants] = useState([]);
    const [currentPlant, setCurrentPlant] = useState(null);
    const [currentIndex, setCurrentIndex] = useState(-1);

    const retrieveAgendaItems = useCallback(() => {
        AgendaDataService.findByGreenhouse(greenhouse)
            .then((response) => {
                setPlants(response.data);
                console.log(response.data);
            })
            .catch((e) => {
                console.log(e);
            });
    }, [greenhouse]);

    useEffect(() => {
        retrievePlants();
    }, [retrievePlants]);

    const setActivePlant = (plant, index) => {
        setCurrentPlant(plant);
        setCurrentIndex(index);
    };

    return (
        <div className="list row">
            <div className="col-md-12">
            </div>
            <div className="col-md-12">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <h3>Agenda</h3>
                </div>

                <ul className="list-group">
                    {plants &&
                        plants.map((plant, index) => (
                            <PlantsListItem
                                key={plant.id}
                                plant={plant}
                                index={index}
                                currentIndex={currentIndex}
                                onSetActive={setActivePlant}
                            />
                        ))}
                </ul>
            </div>
        </div>
    );
};

export default withAuth0(Agenda);