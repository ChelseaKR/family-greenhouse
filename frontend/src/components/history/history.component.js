import React, { useState, useEffect, useCallback } from "react";
import HistoryDataService from "../../services/history.service";
import { withAuth0 } from "@auth0/auth0-react";
import HistoryItem from "./history-item.component";

import "../../styles/history-table.css";

const History = ({ auth0 }) => {
    const { user } = auth0;
    const [greenhouse] = useState(user.greenhouse);
    const [historyItems, setHistoryItems] = useState([]);
    const [setCurrentHistoryItem] = useState(null);
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

    const setActiveHistoryItem = (item, index) => {
        setCurrentHistoryItem(item);
        setCurrentIndex(index);
    };

    return (
        <div>
            <div className="row">
                <div className="col-md-12">
                </div>
                <div className="col-md-12">
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <h3>History</h3>
                    </div>

                    <table className="table table-striped">
                        <thead>
                        <tr>
                            <th>Completed?</th>
                            <th>Date/Time</th>
                            <th>Task</th>
                            <th>Plant Name</th>
                            <th>Plant Type</th>
                            <th>Completed By</th>
                            <th>Date Completed</th>
                        </tr>
                        </thead>
                        <tbody>
                        {historyItems &&
                            historyItems.map((historyItem, index) => (
                                <HistoryItem
                                    key={historyItem.id}
                                    event={historyItem}
                                    index={index}
                                    currentIndex={currentIndex}
                                    onSetActive={setActiveHistoryItem}
                                />
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
};

export default withAuth0(History);