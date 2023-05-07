import React, { useState, useEffect, useCallback } from "react";
import HistoryDataService from "../../services/history.service";
import { withAuth0 } from "@auth0/auth0-react";
import HistoryItem from "./history-item";

const History = ({ auth0 }) => {
    const { user } = auth0;
    const [greenhouse, setGreenhouse] = useState(user.greenhouse);
    const [historyItems, setHistoryItems] = useState([]);
    const [currentHistoryItem, setCurrentHistoryItem] = useState(null);
    const [currentIndex, setCurrentIndex] = useState(-1);

    const retrieveHistoryItems = useCallback(() => {
        HistoryDataService.findByGreenhouse(greenhouse)
            .then((response) => {
                setHistoryItems(response.data);
            })
            .catch((e) => {
                console.log(e);
            });
    }, [greenhouse]);

    useEffect(() => {
        retrieveHistoryItems();
    }, [retrieveHistoryItems]);

    const setActiveHistoryItem = (plant, index) => {
        setCurrentHistoryItem(plant);
        setCurrentIndex(index);
    };

    return (
        <div className="list row">
            <div className="col-md-12">
            </div>
            <div className="col-md-12">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <h3>History</h3>
                </div>

                <ul className="list-group">
                    {Array.isArray(historyItems) &&
                        historyItems.map((historyItem, index) => (
                            <HistoryItem
                                key={historyItem.id}
                                historyItem={historyItem}
                                index={index}
                                currentIndex={currentIndex}
                                onSetActive={setActiveHistoryItem}
                            />
                        ))}
                </ul>
            </div>
        </div>
    );
};

export default withAuth0(History);