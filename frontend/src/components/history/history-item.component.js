import React, {useEffect, useRef, useState} from "react";
import axios from 'axios';
import { useAuth0 } from "@auth0/auth0-react";

import "../../styles/history-table.css";

const HistoryItemComponent = ({ event, index, currentIndex, onSetActive }) => {
    const [isCompleted, setIsCompleted] = useState(event.is_completed);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState(null);
    const isMounted = useRef(true);
    const { user } = useAuth0();

    useEffect(() => {
        return () => {
            isMounted.current = false;
        };
    }, []);

    const handleCheckboxChange = async () => {
        setIsLoading(true);
        const completed_by = !isCompleted ? user.email : null;
        const date_completed = !isCompleted ? new Date() : null;

        try {
            await axios.put(
                `${process.env.REACT_APP_APP_API_URL}/history/${event.id}`,
                {
                    is_completed: !isCompleted,
                    completed_by: completed_by,
                    date_completed: date_completed
                }
            );
            setError(null);

            event.is_completed = !isCompleted;
            event.completed_by = completed_by;
            event.date_completed = date_completed;
            setIsCompleted(!isCompleted);
        } catch (err) {
            setError(err.response?.data?.message || 'An unspecified error occurred');
        } finally {
            if (isMounted.current) {
                setIsLoading(false);
            }
        }
    };

    if (!event) {
        return (
            <tr>
                <td colSpan="5">No event data available.</td>
            </tr>
        );
    }

    const formatDate = (dateObj) => {
        const date = new Date(dateObj);

        const dateString = date.toLocaleDateString();
        const timeString = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        return `${dateString} ${timeString}`;
    };

    return (
        <>
            {error && <div>{error}</div>}
            <tr
                className={index === currentIndex ? "table-active" : ""}
                onClick={() => onSetActive(event, index)}
            >
                <td className="completedColumn" data-label="Completed?">
                    <input
                        type="checkbox"
                        checked={isCompleted}
                        disabled={isLoading}
                        onChange={handleCheckboxChange}
                    />
                </td>
                <td className="datetimeColumn" data-label="Date/Time">{event.datetime ? formatDate(event.datetime) : ""}</td>
                <td className="taskColumn" data-label="Task">{event.task ? event.task.task_type : ""}</td>
                <td className="plantNameColumn" data-label="Plant Name">{event.task.plant ? event.task.plant.name : ""}</td>
                <td className="plantTypeColumn" data-label="Plant Type">{event.task.plant ? event.task.plant.type : ""}</td>
                <td className={`completedByColumn ${!isCompleted ? 'hide-on-mobile' : ''}`} data-label="Completed By">{event.completed_by}</td>
                <td className={`dateCompletedColumn ${!isCompleted ? 'hide-on-mobile' : ''}`} data-label="Date Completed">{event.date_completed ? formatDate(event.date_completed) : ""}</td>
            </tr>
        </>
    );

};




export default React.memo(HistoryItemComponent);
